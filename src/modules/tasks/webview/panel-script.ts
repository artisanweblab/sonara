import { buildIconsScriptDecl } from '../../../shared/webview/icons';

export const PANEL_SCRIPT = `
${buildIconsScriptDecl()}
(function () {
    const vscode = acquireVsCodeApi();

    const CHEVRON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="4,6 8,10 12,6"/></svg>';

    const DEFAULT_META = {
        statuses: [],
        statusLabels: {},
        priorities: [],
        priorityLabels: {},
        priorityRank: {},
        noStatusSectionId: 'no-status',
    };

    let state = {
        tasks: [],
        errors: [],
        hasTasksDir: false,
        projectName: '',
        collapsedSections: [],
        filters: { priorities: [], sprints: [], labels: [] },
        meta: DEFAULT_META,
    };
    let searchQuery = '';
    let collapsedSections = new Set();

    const root = document.getElementById('root');
    const searchInput = document.getElementById('searchInput');
    const filterBar = document.getElementById('filterBar');

    let searchTimer = null;
    searchInput.addEventListener('input', function () {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(function () {
            searchQuery = searchInput.value.trim().toLowerCase();
            render();
        }, 200);
    });

    // Single delegated click listener for the whole task list.
    // Survives any number of re-renders.
    root.addEventListener('click', function (e) {
        // Section header / section add.
        const sectionAdd = e.target.closest('.section-add');
        if (sectionAdd) {
            e.stopPropagation();
            const status = sectionAdd.dataset.status;
            if (status) vscode.postMessage({ type: 'newTask', status });
            return;
        }
        const sectionCopy = e.target.closest('.section-copy-md');
        if (sectionCopy) {
            e.stopPropagation();
            const sid = sectionCopy.dataset.sectionId;
            const mode = sectionCopy.dataset.mode === 'full' ? 'full' : 'summary';
            if (sid) vscode.postMessage({ type: 'copySectionAsMarkdown', sectionId: sid, mode: mode });
            return;
        }
        const sectionHeader = e.target.closest('.section-header');
        if (sectionHeader) {
            const id = sectionHeader.dataset.sectionId;
            if (!id) return;
            const willCollapse = !collapsedSections.has(id);
            if (willCollapse) collapsedSections.add(id);
            else collapsedSections.delete(id);
            render();
            vscode.postMessage({ type: 'toggleSection', sectionId: id, collapsed: willCollapse });
            return;
        }

        // Clickable chip / status / priority -> open the corresponding picker.
        const clickable = e.target.closest('[data-action]');
        if (clickable && root.contains(clickable) && !clickable.classList.contains('icon-btn') && !clickable.classList.contains('section-add')) {
            e.stopPropagation();
            const action = clickable.dataset.action;
            const id = clickable.closest('[data-id]') ? clickable.closest('[data-id]').dataset.id : null;
            if (action && id) {
                vscode.postMessage({ type: action, id });
            }
            return;
        }

        // Timer Start/Stop button.
        const timerBtn = e.target.closest('.timer-btn');
        if (timerBtn && root.contains(timerBtn)) {
            e.stopPropagation();
            const slug = timerBtn.dataset.timerSlug;
            if (slug) vscode.postMessage({ type: 'timerToggle', slug: slug });
            return;
        }

        // Card-level action button.
        const iconBtn = e.target.closest('.icon-btn');
        if (iconBtn && root.contains(iconBtn)) {
            e.stopPropagation();
            const action = iconBtn.dataset.action;
            const id = iconBtn.closest('[data-id]') ? iconBtn.closest('[data-id]').dataset.id : null;
            if (!action || !id) return;
            vscode.postMessage({ type: action, id });
            return;
        }

        // Title click opens preview.
        const title = e.target.closest('.card-title');
        if (title) {
            e.stopPropagation();
            const id = title.closest('[data-id]') ? title.closest('[data-id]').dataset.id : null;
            if (id) vscode.postMessage({ type: 'openPreview', id });
            return;
        }
    });

    filterBar.addEventListener('click', function (e) {
        const copyAll = e.target.closest('.filter-copy-md');
        if (copyAll) {
            const mode = copyAll.dataset.mode === 'full' ? 'full' : 'summary';
            vscode.postMessage({ type: 'copyAllAsMarkdown', mode: mode });
            return;
        }
        const removeTarget = e.target.closest('[data-filter-remove]');
        if (removeTarget) {
            vscode.postMessage({
                type: 'toggleFilterValue',
                kind: removeTarget.dataset.filterRemove,
                value: removeTarget.dataset.filterValue,
            });
            return;
        }
        const chip = e.target.closest('[data-filter-kind]');
        if (chip) {
            const kind = chip.dataset.filterKind;
            if (kind) vscode.postMessage({ type: 'openFilterPicker', kind: kind });
            return;
        }
        const clear = e.target.closest('.filter-clear');
        if (clear) {
            vscode.postMessage({ type: 'clearFilters' });
            return;
        }
    });

    window.addEventListener('message', function (event) {
        const msg = event.data;
        if (msg.type === 'state') {
            state = msg.state;
            collapsedSections = new Set(state.collapsedSections || []);
            render();
        } else if (msg.type === 'copied') {
            flashCopied(msg.id, msg.kind);
        } else if (msg.type === 'copiedMarkdown') {
            flashCopiedMarkdown(msg.scope, msg.mode, msg.sectionId);
        }
    });

    function flashCopiedMarkdown(scope, mode, sectionId) {
        const safeMode = mode === 'full' ? 'full' : 'summary';
        let btn = null;
        if (scope === 'section' && sectionId) {
            btn = root.querySelector('.section-copy-md[data-section-id="' + cssEscape(sectionId) + '"][data-mode="' + safeMode + '"]');
        } else {
            btn = filterBar.querySelector('.filter-copy-md[data-mode="' + safeMode + '"]');
        }
        if (!btn) return;
        const iconHost = btn.querySelector('.filter-copy-md-icon') || btn;
        const original = btn.dataset.iconOriginal || iconHost.innerHTML;
        iconHost.innerHTML = ICON_COPIED;
        btn.classList.add('copied');
        setTimeout(function () {
            iconHost.innerHTML = original;
            btn.classList.remove('copied');
        }, 1500);
    }

    function render() {
        root.innerHTML = '';
        renderFilterBar();

        if (!state.hasTasksDir) {
            renderWelcome();
            return;
        }

        const filteredTasks = filterTasks(state.tasks, searchQuery);
        const filteredErrors = filterErrors(state.errors, searchQuery);

        const byStatus = new Map();
        const noStatus = [];
        for (const t of filteredTasks) {
            if (t.status === null) {
                noStatus.push(t);
            } else {
                if (!byStatus.has(t.status)) byStatus.set(t.status, []);
                byStatus.get(t.status).push(t);
            }
        }

        for (const status of state.meta.statuses) {
            const list = byStatus.get(status) || [];
            list.sort(byCreatedDesc);
            renderStatusSection(status, list);
        }
        if (noStatus.length > 0) {
            noStatus.sort(byCreatedDesc);
            renderInfoSection(state.meta.noStatusSectionId, 'No Status', noStatus, false);
        }
        if (filteredErrors.length > 0) {
            renderInfoSection('errors', 'Parse Errors', filteredErrors, true);
        }
    }

    function renderWelcome() {
        const div = document.createElement('div');
        div.className = 'welcome';
        div.innerHTML = '<p>Open a workspace folder to use Sonara Tasks.</p>';
        root.appendChild(div);
    }

    function renderStatusSection(status, tasks) {
        const section = buildSection(status, state.meta.statusLabels[status] || status, tasks.length, status);
        const list = section.querySelector('.section-list');

        if (tasks.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'empty-section';
            empty.textContent = searchQuery ? 'No matches.' : 'No tasks.';
            list.appendChild(empty);
        } else {
            for (const t of tasks) {
                list.appendChild(buildTaskCard(t));
            }
        }
        root.appendChild(section);
    }

    function renderInfoSection(id, label, items, isErrors) {
        const section = buildSection(id, label, items.length, null);
        const list = section.querySelector('.section-list');
        for (const item of items) {
            list.appendChild(isErrors ? buildErrorCard(item) : buildTaskCard(item));
        }
        root.appendChild(section);
    }

    function buildSection(id, label, count, statusForAdd) {
        const section = document.createElement('div');
        section.className = 'section' + (collapsedSections.has(id) ? ' collapsed' : '');
        section.dataset.sectionId = id;

        const header = document.createElement('div');
        header.className = 'section-header';
        header.dataset.sectionId = id;

        const chevron = document.createElement('span');
        chevron.className = 'section-chevron';
        chevron.innerHTML = CHEVRON_SVG;
        header.appendChild(chevron);

        const title = document.createElement('span');
        title.className = 'section-title';
        title.innerHTML = escHtml(label) + '<span class="section-count">' + count + '</span>';
        header.appendChild(title);

        if (statusForAdd) {
            const add = document.createElement('button');
            add.className = 'section-add';
            add.title = 'Create task in ' + label;
            add.textContent = '+';
            add.dataset.status = statusForAdd;
            header.appendChild(add);
        }
        if (id !== 'errors') {
            const copySummaryBtn = document.createElement('button');
            copySummaryBtn.className = 'section-copy-md';
            copySummaryBtn.title = 'Copy these tasks as summary table';
            copySummaryBtn.innerHTML = ICON_COPY;
            copySummaryBtn.dataset.iconOriginal = ICON_COPY;
            copySummaryBtn.dataset.sectionId = id;
            copySummaryBtn.dataset.mode = 'summary';
            if (!statusForAdd) copySummaryBtn.classList.add('section-copy-md-alone');
            header.appendChild(copySummaryBtn);

            const copyFullBtn = document.createElement('button');
            copyFullBtn.className = 'section-copy-md';
            copyFullBtn.title = 'Copy these tasks with full content';
            copyFullBtn.innerHTML = ICON_COPY_FULL;
            copyFullBtn.dataset.iconOriginal = ICON_COPY_FULL;
            copyFullBtn.dataset.sectionId = id;
            copyFullBtn.dataset.mode = 'full';
            header.appendChild(copyFullBtn);
        }
        section.appendChild(header);

        const list = document.createElement('div');
        list.className = 'section-list';
        section.appendChild(list);

        return section;
    }

    function buildTaskCard(task) {
        const card = document.createElement('div');
        card.className = 'card';
        card.dataset.id = task.id;
        card.dataset.priority = task.priority;

        // Top row: clickable status + priority chips on the left, action icons on the right.
        const topRow = document.createElement('div');
        topRow.className = 'card-top-row';

        const meta = document.createElement('div');
        meta.className = 'card-meta';
        const statusLabel = task.status ? state.meta.statusLabels[task.status] || task.status : 'no status';
        meta.innerHTML =
            '<span class="card-status chip-clickable" data-action="changeStatus" data-status="' + escAttr(task.status || '') + '" title="Change status">' + escHtml(statusLabel) + '</span>' +
            '<span class="card-priority chip-clickable" data-action="changePriority" data-priority="' + escAttr(task.priority) + '" title="Change priority">' + escHtml(state.meta.priorityLabels[task.priority] || task.priority) + '</span>';
        topRow.appendChild(meta);

        const topActions = document.createElement('div');
        topActions.className = 'card-actions';
        if (task.slug) {
            const timerBtn = document.createElement('button');
            timerBtn.className = 'icon-btn timer-btn' + (task.isTimerActive ? ' timer-btn-active' : '');
            timerBtn.title = task.isTimerActive ? 'Stop time tracking' : 'Start time tracking';
            timerBtn.dataset.timerSlug = task.slug;
            timerBtn.innerHTML = task.isTimerActive
                ? '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><rect x="4" y="4" width="8" height="8" rx="1"/></svg>'
                : '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M5 3.5v9l8-4.5z"/></svg>';
            topActions.appendChild(timerBtn);
        }
        topActions.appendChild(buildIconBtn('Open preview', ICON_SHOW, 'openPreview'));
        topActions.appendChild(buildIconBtn('Edit task file', ICON_EDIT, 'openEditor'));
        topActions.appendChild(buildIconBtn('Reveal in File Explorer', ICON_REVEAL, 'revealInOS'));
        topActions.appendChild(buildIconBtn('Copy task body', ICON_COPY, 'copyText', 'text'));
        topActions.appendChild(buildIconBtn('Copy file path', ICON_COPY_PATH, 'copyPath', 'path'));
        const deleteBtn = buildIconBtn('Delete task', ICON_DELETE, 'delete');
        deleteBtn.classList.add('icon-btn-danger');
        topActions.appendChild(deleteBtn);
        topRow.appendChild(topActions);

        card.appendChild(topRow);

        const title = document.createElement('div');
        title.className = 'card-title';
        title.textContent = task.title;
        title.title = 'Open preview';
        card.appendChild(title);

        const chips = document.createElement('div');
        chips.className = 'card-chips';

        const sprintChip = document.createElement('span');
        if (task.sprint) {
            sprintChip.className = 'chip chip-sprint';
            sprintChip.textContent = task.sprint;
        } else {
            sprintChip.className = 'chip chip-placeholder';
            sprintChip.appendChild(buildChipIcon('add'));
            const lbl = document.createElement('span');
            lbl.textContent = 'sprint';
            sprintChip.appendChild(lbl);
        }
        sprintChip.title = 'Change sprint';
        sprintChip.dataset.action = 'changeSprint';
        chips.appendChild(sprintChip);

        if (task.labels) {
            for (const label of task.labels) {
                const labelChip = document.createElement('span');
                labelChip.className = 'chip chip-label';
                labelChip.title = 'Edit labels';
                labelChip.dataset.action = 'editLabels';
                labelChip.textContent = label;
                chips.appendChild(labelChip);
            }
        }
        if (!task.labels || task.labels.length === 0) {
            const labelsPlaceholder = document.createElement('span');
            labelsPlaceholder.className = 'chip chip-placeholder';
            labelsPlaceholder.title = 'Edit labels';
            labelsPlaceholder.dataset.action = 'editLabels';
            labelsPlaceholder.appendChild(buildChipIcon('add'));
            const lbl = document.createElement('span');
            lbl.textContent = 'labels';
            labelsPlaceholder.appendChild(lbl);
            chips.appendChild(labelsPlaceholder);
        }
        card.appendChild(chips);

        if (task.summary) {
            const summary = document.createElement('div');
            summary.className = 'card-summary';
            summary.textContent = task.summary;
            card.appendChild(summary);
        }

        if (typeof task.timeTotalSec === 'number' && task.timeTotalSec > 0) {
            const time = document.createElement('div');
            time.className = 'card-time' + (task.isTimerActive ? ' card-time-active' : '');
            time.textContent = formatHms(task.timeTotalSec);
            card.appendChild(time);
        } else if (task.isTimerActive) {
            const time = document.createElement('div');
            time.className = 'card-time card-time-active';
            time.textContent = '0h 0m 0s';
            card.appendChild(time);
        }

        return card;
    }

    function formatHms(sec) {
        sec = Math.max(0, Math.floor(sec));
        const h = Math.floor(sec / 3600);
        const m = Math.floor((sec % 3600) / 60);
        const s = sec % 60;
        return h + 'h ' + m + 'm ' + s + 's';
    }

    function buildErrorCard(error) {
        const card = document.createElement('div');
        card.className = 'card error';
        card.dataset.id = error.id;

        const topRow = document.createElement('div');
        topRow.className = 'card-top-row';

        const meta = document.createElement('div');
        meta.className = 'card-meta';
        meta.innerHTML = '<span class="card-status" data-status="error">parse error</span>';
        topRow.appendChild(meta);

        const topActions = document.createElement('div');
        topActions.className = 'card-actions';
        topActions.appendChild(buildIconBtn('Edit file', ICON_EDIT, 'openEditor'));
        topActions.appendChild(buildIconBtn('Copy file path', ICON_COPY_PATH, 'copyPath', 'path'));
        const delBtn = buildIconBtn('Delete file', ICON_DELETE, 'delete');
        delBtn.classList.add('icon-btn-danger');
        topActions.appendChild(delBtn);
        topRow.appendChild(topActions);

        card.appendChild(topRow);

        const title = document.createElement('div');
        title.className = 'card-title';
        title.textContent = error.fileName;
        card.appendChild(title);

        const msg = document.createElement('div');
        msg.className = 'card-error-msg';
        msg.textContent = error.message;
        card.appendChild(msg);

        return card;
    }

    function buildIconBtn(label, svg, action, kind) {
        const btn = document.createElement('button');
        btn.className = 'icon-btn';
        btn.title = label;
        btn.innerHTML = svg;
        btn.dataset.action = action;
        btn.dataset.iconOriginal = svg;
        if (kind) btn.dataset.copyKind = kind;
        return btn;
    }

    function flashCopied(id, kind) {
        const escaped = cssEscape(id);
        const selector = kind
            ? '[data-id="' + escaped + '"] .icon-btn[data-copy-kind="' + kind + '"]'
            : '[data-id="' + escaped + '"] .icon-btn[data-copy-kind]';
        const btn = root.querySelector(selector);
        if (!btn) return;
        const iconHost = btn.querySelector('.filter-copy-md-icon') || btn;
        const original = btn.dataset.iconOriginal || iconHost.innerHTML;
        iconHost.innerHTML = ICON_COPIED;
        btn.classList.add('copied');
        setTimeout(function () {
            iconHost.innerHTML = original;
            btn.classList.remove('copied');
        }, 1500);
    }

    function renderFilterBar() {
        filterBar.innerHTML = '';
        if (!state.hasTasksDir) return;
        const f = state.filters || { priorities: [], sprints: [], labels: [] };

        renderFilterGroup('priority', f.priorities || [], 'priority', function (v) {
            const chip = document.createElement('span');
            chip.className = 'chip';
            chip.dataset.priority = v;
            chip.style.color = priorityColor(v);
            chip.style.background = 'color-mix(in srgb, currentColor 22%, transparent)';
            chip.textContent = state.meta.priorityLabels[v] || v;
            return chip;
        });
        const noSprintValue = (state.meta && state.meta.noSprintFilterValue) || '__none__';
        const noSprintLabel = (state.meta && state.meta.noSprintFilterLabel) || 'No sprint';
        const noLabelsValue = (state.meta && state.meta.noLabelsFilterValue) || '__none__';
        const noLabelsLabel = (state.meta && state.meta.noLabelsFilterLabel) || 'No labels';
        renderFilterGroup('sprint', f.sprints || [], 'sprint', function (v) {
            const chip = document.createElement('span');
            chip.className = 'chip chip-sprint';
            chip.textContent = v === noSprintValue ? noSprintLabel : v;
            return chip;
        });
        renderFilterGroup('label', f.labels || [], 'labels', function (v) {
            const chip = document.createElement('span');
            chip.className = 'chip chip-label';
            chip.textContent = v === noLabelsValue ? noLabelsLabel : v;
            return chip;
        });

        const actionsBreak = document.createElement('span');
        actionsBreak.className = 'filter-actions-break';
        filterBar.appendChild(actionsBreak);

        filterBar.appendChild(buildFilterCopyButton('summary', 'Copy summary', 'Copy visible tasks as summary table'));
        filterBar.appendChild(buildFilterCopyButton('full', 'Copy full', 'Copy visible tasks with full content'));

        if ((f.priorities || []).length || (f.sprints || []).length || (f.labels || []).length) {
            const clear = document.createElement('button');
            clear.className = 'filter-clear';
            clear.title = 'Reset all filters';
            const text = document.createElement('span');
            text.textContent = 'Reset filter';
            clear.appendChild(text);
            const icon = document.createElement('span');
            icon.className = 'filter-clear-icon';
            icon.innerHTML = '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 4 13 4"/><path d="M5 4v9a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1V4"/><path d="M6.5 4V2.5a.5.5 0 0 1 .5-.5h2a.5.5 0 0 1 .5.5V4"/><line x1="7" y1="6.5" x2="7" y2="11.5"/><line x1="9" y1="6.5" x2="9" y2="11.5"/></svg>';
            clear.appendChild(icon);
            filterBar.appendChild(clear);
        }
    }

    function buildFilterCopyButton(mode, label, tooltip) {
        const btn = document.createElement('button');
        btn.className = 'filter-copy-md';
        btn.title = tooltip;
        btn.dataset.mode = mode;
        const labelSpan = document.createElement('span');
        labelSpan.textContent = label;
        btn.appendChild(labelSpan);
        const icon = document.createElement('span');
        icon.className = 'filter-copy-md-icon';
        const iconSvg = mode === 'full' ? ICON_COPY_FULL : ICON_COPY;
        icon.innerHTML = iconSvg;
        btn.appendChild(icon);
        btn.dataset.iconOriginal = iconSvg;
        return btn;
    }

    function renderFilterGroup(kind, selected, placeholderName, buildChip) {
        for (const value of selected) {
            const chip = buildChip(value);
            chip.dataset.filterRemove = kind;
            chip.dataset.filterValue = value;
            chip.title = 'Remove';
            chip.appendChild(buildChipIcon('remove'));
            filterBar.appendChild(chip);
        }
        const placeholder = document.createElement('span');
        placeholder.className = 'chip chip-placeholder';
        placeholder.dataset.filterKind = kind;
        placeholder.appendChild(buildChipIcon('add'));
        const label = document.createElement('span');
        label.textContent = placeholderName;
        placeholder.appendChild(label);
        filterBar.appendChild(placeholder);
    }

    function buildChipIcon(kind) {
        const span = document.createElement('span');
        span.className = 'chip-icon chip-icon-' + kind;
        span.innerHTML = kind === 'add'
            ? '<svg viewBox="0 0 8 8" width="6" height="6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4 1 L4 7 M1 4 L7 4"/></svg>'
            : '<svg viewBox="0 0 8 8" width="6" height="6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M1 1 L7 7 M7 1 L1 7"/></svg>';
        return span;
    }

    function priorityColor(priority) {
        switch (priority) {
            case 'highest': return 'var(--vscode-charts-red)';
            case 'high':    return '#ff9100';
            case 'medium':  return '#a3b300';
            case 'low':     return 'var(--vscode-charts-blue)';
            case 'lowest':  return 'var(--vscode-charts-foreground)';
            default:        return 'var(--vscode-charts-foreground)';
        }
    }

    function filterTasks(tasks, q) {
        const f = state.filters || { priorities: [], sprints: [], labels: [] };
        const hasP = (f.priorities || []).length > 0;
        const hasS = (f.sprints || []).length > 0;
        const hasL = (f.labels || []).length > 0;
        const noSprintValue = (state.meta && state.meta.noSprintFilterValue) || '__none__';
        const noLabelsValue = (state.meta && state.meta.noLabelsFilterValue) || '__none__';
        const sprintAcceptsNone = hasS && f.sprints.indexOf(noSprintValue) !== -1;
        const labelsAcceptsNone = hasL && f.labels.indexOf(noLabelsValue) !== -1;
        return tasks.filter(function (t) {
            if (hasP && f.priorities.indexOf(t.priority) === -1) return false;
            if (hasS) {
                if (t.sprint) {
                    if (f.sprints.indexOf(t.sprint) === -1) return false;
                } else {
                    if (!sprintAcceptsNone) return false;
                }
            }
            if (hasL) {
                const isEmpty = !t.labels || t.labels.length === 0;
                if (isEmpty) {
                    if (!labelsAcceptsNone) return false;
                } else {
                    let match = false;
                    for (const l of t.labels) {
                        if (f.labels.indexOf(l) !== -1) { match = true; break; }
                    }
                    if (!match) return false;
                }
            }
            if (q) {
                if (!((t.title || '').toLowerCase().includes(q)
                    || (t.summary || '').toLowerCase().includes(q)
                    || (t.body || '').toLowerCase().includes(q))) return false;
            }
            return true;
        });
    }

    function filterErrors(errors, q) {
        if (!q) return errors.slice();
        return errors.filter(function (e) {
            return (e.fileName || '').toLowerCase().includes(q)
                || (e.message || '').toLowerCase().includes(q);
        });
    }

    function byCreatedDesc(a, b) {
        const rank = state.meta.priorityRank;
        const ra = rank[a.priority] !== undefined ? rank[a.priority] : 2;
        const rb = rank[b.priority] !== undefined ? rank[b.priority] : 2;
        if (ra !== rb) return ra - rb;
        const aHas = !!a.created, bHas = !!b.created;
        if (aHas !== bHas) return aHas ? -1 : 1;
        if (a.created !== b.created) return (b.created || '').localeCompare(a.created || '');
        return a.title.localeCompare(b.title);
    }

    function escHtml(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function escAttr(s) {
        return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    }

    function cssEscape(s) {
        return String(s).replace(/[\\\\"']/g, '\\\\$&');
    }

    vscode.postMessage({ type: 'ready' });
})();
`;
