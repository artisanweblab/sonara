import { buildIconsScriptDecl } from '../../../../shared/webview/icons';

export const PANEL_SCRIPT = `
${buildIconsScriptDecl()}
(function() {
    const vscode = acquireVsCodeApi();
    let allRecords = [];
    let expandedIds = new Set();
    let editingId = null;
    let showAll = false;
    let currentDraft = null;
    let draftTickInterval = null;

    const list = document.getElementById('logList');
    const searchInput = document.getElementById('searchInput');
    let searchTimer = null;
    searchInput.addEventListener('input', function() {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(function() {
            showAll = false;
            vscode.postMessage({ type: 'search', query: searchInput.value });
        }, 200);
    });

    // Single delegated click listener — survives every re-render.
    list.addEventListener('click', function(e) {
        const editAction = e.target.closest('[data-action="edit-save"], [data-action="edit-cancel"]');
        if (editAction) {
            e.stopPropagation();
            const id = editAction.dataset.id;
            if (editAction.dataset.action === 'edit-save') {
                const card = editAction.closest('.record-card');
                const ta = card ? card.querySelector('.edit-area') : null;
                if (ta) {
                    editingId = null;
                    vscode.postMessage({ type: 'edit', id, text: ta.value });
                }
            } else {
                editingId = null;
                renderRecords(allRecords);
            }
            return;
        }

        const iconBtn = e.target.closest('.icon-btn');
        if (iconBtn) {
            e.stopPropagation();
            const action = iconBtn.dataset.action;
            const card = iconBtn.closest('[data-id]');
            const id = card ? card.dataset.id : null;
            if (!action || !id) return;
            if (action === 'edit') {
                editingId = id;
                renderRecords(allRecords);
                return;
            }
            if (action === 'expand') {
                if (expandedIds.has(id)) expandedIds.delete(id);
                else expandedIds.add(id);
                renderRecords(allRecords);
                return;
            }
            if (action === 'copy' || action === 'delete') {
                vscode.postMessage({ type: action, id });
                return;
            }
        }
    });

    window.addEventListener('message', function(event) {
        const msg = event.data;
        switch (msg.type) {
            case 'records':
                allRecords = msg.records || [];
                renderRecords(allRecords);
                break;
            case 'draft': {
                const prevHadDraft = currentDraft !== null;
                currentDraft = msg.draft || null;
                const nowHasDraft = currentDraft !== null;
                // Re-render the list only when the draft card itself appears or disappears,
                // so the empty-state placeholder toggles correctly. The record list ordering
                // is pure chronology and never depends on draft mode.
                if (prevHadDraft !== nowHasDraft && (allRecords.length === 0)) {
                    renderRecords(allRecords);
                } else {
                    updateDraftCard();
                }
                break;
            }
            case 'copied':
                flashCopied(msg.id);
                break;
            case 'toggleShowAll':
                showAll = !showAll;
                renderRecords(allRecords);
                break;
            case 'clearSearch':
                if (searchInput.value !== '') {
                    clearTimeout(searchTimer);
                    searchInput.value = '';
                }
                break;
        }
    });

    function updateDraftCard() {
        const existing = document.getElementById('draftCard');
        if (!currentDraft) {
            if (existing) existing.remove();
            stopDraftTicker();
            return;
        }
        const card = existing || buildDraftCard();
        const confirmedEl = card.querySelector('.draft-confirmed');
        const pendingEl = card.querySelector('.draft-pending');
        const labelEl = card.querySelector('.draft-label');
        const placeholderEl = card.querySelector('.draft-placeholder');
        const mode = currentDraft.mode || 'live';
        card.dataset.mode = mode;
        if (mode === 'transcribing') {
            labelEl.textContent = 'Transcribing';
        } else if (mode === 'recording') {
            labelEl.textContent = 'Recording';
        } else {
            labelEl.textContent = 'Live';
        }
        confirmedEl.textContent = currentDraft.confirmedText || '';
        pendingEl.textContent = currentDraft.pendingText || '';
        const hasText = (currentDraft.confirmedText || currentDraft.pendingText || '').length > 0;
        placeholderEl.style.display = hasText ? 'none' : 'inline';
        const textEl = card.querySelector('.record-text');
        if (textEl) {
            const isActive = mode === 'live' || mode === 'recording' || mode === 'transcribing';
            textEl.classList.toggle('draft-running', isActive && hasText);
            if (isActive && hasText) {
                textEl.scrollTop = textEl.scrollHeight;
            } else {
                textEl.scrollTop = 0;
            }
        }
        if (mode === 'transcribing') {
            placeholderEl.textContent = hasText
                ? ''
                : 'Transcribing your speech...';
        } else if (mode === 'recording') {
            placeholderEl.textContent = 'Recording...';
        } else {
            placeholderEl.textContent = 'Listening...';
        }
        renderDraftDuration(card);
        if (!existing) {
            list.insertBefore(card, list.firstChild);
        }
        if (mode === 'transcribing') {
            stopDraftTicker();
        } else {
            startDraftTicker();
        }
    }

    function renderDraftDuration(card) {
        const durationEl = card.querySelector('.draft-duration');
        if (!durationEl || !currentDraft) return;
        const mode = currentDraft.mode || 'live';
        if (mode === 'transcribing') {
            durationEl.textContent = formatDraftDuration(currentDraft.durationSec || 0);
            return;
        }
        const startMs = currentDraft.startedAt ? Date.parse(currentDraft.startedAt) : NaN;
        const elapsedSec = isFinite(startMs)
            ? Math.max(0, (Date.now() - startMs) / 1000)
            : (currentDraft.durationSec || 0);
        durationEl.textContent = formatDraftDuration(elapsedSec);
    }

    function startDraftTicker() {
        if (draftTickInterval) return;
        draftTickInterval = setInterval(function() {
            const card = document.getElementById('draftCard');
            if (!card || !currentDraft) {
                stopDraftTicker();
                return;
            }
            renderDraftDuration(card);
        }, 500);
    }

    function stopDraftTicker() {
        if (draftTickInterval) {
            clearInterval(draftTickInterval);
            draftTickInterval = null;
        }
    }

    function buildDraftCard() {
        const card = document.createElement('div');
        card.id = 'draftCard';
        card.className = 'record-card draft';

        const meta = document.createElement('div');
        meta.className = 'record-meta';
        meta.innerHTML =
            '<span class="draft-dot"></span>' +
            '<span class="draft-label">Recording</span>' +
            '<span class="record-dur draft-duration">0s</span>';
        card.appendChild(meta);

        const text = document.createElement('div');
        text.className = 'record-text';
        const confirmed = document.createElement('span');
        confirmed.className = 'draft-confirmed';
        const pending = document.createElement('span');
        pending.className = 'draft-pending';
        const placeholder = document.createElement('span');
        placeholder.className = 'draft-placeholder';
        text.appendChild(confirmed);
        text.appendChild(pending);
        text.appendChild(placeholder);
        card.appendChild(text);

        return card;
    }

    function formatDraftDuration(sec) {
        const total = Math.floor(sec);
        const m = Math.floor(total / 60);
        const s = total % 60;
        return m > 0 ? m + 'm ' + s + 's' : s + 's';
    }

    function renderRecords(records) {
        list.innerHTML = '';

        if (!records || records.length === 0) {
            if (!currentDraft) {
                list.innerHTML = '<div class="empty-state"><div class="empty-icon">\u{1F3A4}</div><div>No voice records yet.<br>Press Ctrl+Shift+M to start recording.</div></div>';
            }
            updateDraftCard();
            vscode.postMessage({ type: 'showAllState', canToggle: false, showAll: showAll });
            return;
        }

        // Strict chronological order, newest on top. Status (copied / unread / recording)
        // never influences ordering or visibility of saved records. The draft card for an
        // in-progress recording is rendered separately above by updateDraftCard().
        const sorted = records.slice().sort(function(a, b) {
            return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
        });

        const visible = showAll ? sorted : sorted.slice(0, 1);
        visible.forEach(r => list.appendChild(buildCard(r)));

        updateDraftCard();
        vscode.postMessage({ type: 'showAllState', canToggle: sorted.length > 1, showAll: showAll });
    }

    function buildCard(record) {
        const isUnread = record.copied === false;
        const card = document.createElement('div');
        card.className = 'record-card'
            + (isUnread ? ' unread' : '');
        card.dataset.id = record.id;

        const isExpanded = expandedIds.has(record.id);
        const isLong = record.text.length > 105 || record.text.split('\\n').length > 2;

        const d = new Date(record.timestamp);
        const time = formatDate(d) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
        const duration = formatDraftDuration(record.duration_sec || 0);

        const topRow = document.createElement('div');
        topRow.className = 'card-top-row';

        const meta = document.createElement('div');
        meta.className = 'record-meta';
        meta.innerHTML =
            (isUnread ? '<span class="unread-dot" title="Not copied yet"></span>' : '') +
            '<span class="record-time">' + escHtml(time) + '</span>' +
            '<span class="record-duration">' + escHtml(duration) + '</span>';
        topRow.appendChild(meta);

        if (editingId !== record.id) {
            const actions = document.createElement('div');
            actions.className = 'card-actions';
            if (isLong) {
                const expandBtn = makeIconBtn(isExpanded ? 'Show less' : 'Show more', ICON_EXPAND, 'expand');
                if (isExpanded) expandBtn.classList.add('icon-btn-flipped');
                actions.appendChild(expandBtn);
            }
            actions.appendChild(makeIconBtn('Edit', ICON_EDIT, 'edit'));
            actions.appendChild(makeIconBtn('Copy', ICON_COPY, 'copy'));
            actions.appendChild(makeIconBtnDanger('Delete', ICON_DELETE, 'delete'));
            topRow.appendChild(actions);
        }
        card.appendChild(topRow);

        if (editingId === record.id) {
            const textarea = document.createElement('textarea');
            textarea.className = 'edit-area';
            textarea.value = record.text;
            card.appendChild(textarea);

            const editActions = document.createElement('div');
            editActions.className = 'record-actions';
            editActions.innerHTML =
                '<button class="action-btn" data-action="edit-save" data-id="' + escAttr(record.id) + '">Save</button>' +
                '<button class="action-btn" data-action="edit-cancel" data-id="' + escAttr(record.id) + '">Cancel</button>';
            card.appendChild(editActions);
        } else {
            const textEl = document.createElement('div');
            textEl.className = 'record-text' + (isLong && !isExpanded ? ' collapsed' : '');
            textEl.textContent = record.text;
            card.appendChild(textEl);
        }

        return card;
    }

    function makeIconBtn(label, svg, action, isActive) {
        const btn = document.createElement('button');
        btn.className = 'icon-btn' + (isActive ? ' active' : '');
        btn.title = label;
        btn.innerHTML = svg;
        btn.dataset.action = action;
        btn.dataset.iconOriginal = svg;
        return btn;
    }

    function makeIconBtnDanger(label, svg, action) {
        const btn = makeIconBtn(label, svg, action);
        btn.classList.add('icon-btn-danger');
        return btn;
    }

    function flashCopied(id) {
        const card = list.querySelector('[data-id="' + cssEscape(id) + '"]');
        if (!card) return;
        const btn = card.querySelector('.icon-btn[data-action="copy"]');
        if (!btn) return;
        const original = btn.dataset.iconOriginal || btn.innerHTML;
        btn.innerHTML = ICON_COPIED;
        btn.classList.add('copied');
        setTimeout(function() {
            btn.innerHTML = original;
            btn.classList.remove('copied');
        }, 1500);
    }

    function pad(value) {
        return String(value).padStart(2, '0');
    }

    function formatDate(d) {
        return pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + '.' + d.getFullYear();
    }

    function escHtml(str) {
        return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
