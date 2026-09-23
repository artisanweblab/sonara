export const TASKS_README_CONTENT = `# Tasks

Each file is one task. Files are committed with the repo.

In a multi-root workspace, each project has its own \`.vscode/sonara/tasks/\` folder - tasks are NOT shared. If the user does not specify which project a new task belongs to, ASK.

## File layout

\`\`\`markdown
---
title: Short task title
status: inbox
priority: medium
sprint: 2026-W19
labels:
  - auth
  - bug
summary: One short sentence describing the task
created: 2026-04-27T12:00:00.000Z
---

<!-- Sonara task. Format and rules: .vscode/sonara/tasks/README.md -->

Free-form markdown body.
\`\`\`

- Frontmatter must start on line 1 (no leading whitespace or comments).
- One blank line between the closing \`---\`, the HTML comment, and the body.
- Filename: \`kebab-case\` derived from the title, \`.md\` extension. File lives directly in \`.vscode/sonara/tasks/\`.

## Frontmatter formatting

Sonara rewrites the whole frontmatter whenever it changes a field (status, priority, sprint, labels). Write it exactly the way Sonara writes it, otherwise the first such change reformats the task:

- Fields in the order of the example above. A field added later goes after the existing ones.
- \`labels\` as a block list, one \`  - label\` per line. Never the \`[a, b]\` form. No labels - leave the field out.
- Strings without quotes. Use single quotes when the value contains any of \`, : [ ] { }\` or \` #\`, starts with one of \`- ? & * ! | > ' " % @ #\` or a backtick, starts or ends with a space, or reads as a number, \`true\`/\`false\`/\`null\` or a date. Double any \`'\` inside single quotes (\`'It''s: done'\`). Other punctuation (\`; ( ) . / - " '\` inside the text) needs no quotes.
- Every value at most 78 characters. A longer one is folded by Sonara onto several lines, so keep \`title\` and \`summary\` short.
- \`created\` as full ISO with milliseconds and \`Z\`, no quotes: \`2026-04-27T12:00:00.000Z\`.

## Frontmatter

| Field | Required | Notes |
|---|---|---|
| \`title\` | yes | short title |
| \`status\` | yes | see Workflow |
| \`priority\` | no | default \`medium\` |
| \`sprint\` | no | free string (\`2026-W19\`, \`sprint-12\`, \`release-0.3\`); one per task |
| \`labels\` | no | block list of free strings |
| \`summary\` | no | one short sentence shown in the task list, at most 78 characters. If omitted, the first paragraph of the body is used |
| \`created\` | yes | ISO, set automatically |

Set \`summary\` explicitly when the body starts with a checklist or heading.

## Workflow

\`inbox\` -> \`backlog\` -> \`todo\` -> \`in-progress\` -> \`review\` -> \`done\` -> \`released\`

Status meanings:

- \`inbox\` - captured, not triaged yet.
- \`backlog\` - accepted, will be picked up later.
- \`todo\` - planned for the current cycle, not started.
- \`in-progress\` - actively being worked on.
- \`review\` - implementation finished, awaiting verification.
- \`done\` - verified and ready to ship, but not yet deployed. Tasks can sit here for days or weeks until the next release.
- \`released\` - shipped to production. Closes the task's lifecycle on the success path.
- \`cancelled\` - decided not to do it. Closes on the rejection path. Add a short reason in the body.
- \`activity\` - separate parking lot for recurring work that has no end state (meetings, support shifts, monitoring). Tasks in \`activity\` stay there indefinitely and do not flow through the workflow above. They behave like regular tasks otherwise (priority, sprint, labels are optional).

The split between \`done\` and \`released\` exists because work is often shipped in batches: a task completed today may stay in \`done\` until the next release goes out. Use \`done\` to answer "is the work finished?" and \`released\` to answer "is it live for users?".

## Priority

\`highest\`, \`high\`, \`medium\`, \`low\`, \`lowest\`.

## Rules for AI agents

- Default \`status\` for new tasks: \`inbox\`. Never put a new task straight into a later stage without being asked.
- When merging or rewriting a task, reset \`status\` to \`inbox\` and ask the user where it belongs.
- Move through stages in order. Never write directly to \`done\` or \`released\` without going through \`review\`, unless the user explicitly skips it.
- Cancelled work -> \`cancelled\` with a short reason in the body.
- Don't modify other tasks without an explicit request.
- Write task bodies as actionable checklists (\`- [ ] ...\`) so progress is trackable.

### Closing a task

Before \`done\`, \`released\` or \`cancelled\`:
1. Mark each checklist item: \`- [x]\` for done, leave unchecked with a note for skipped (\`- [ ] X - skipped, no longer relevant\`).
2. Append a 2-4 sentence completion summary at the bottom.
`;
