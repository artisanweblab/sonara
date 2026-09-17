export const REVIEW_README_CONTENT = `# Review

This folder stores review marks for uncommitted changes. It is created and maintained by the Sonara extension.

## Rules for AI agents

- **Never write, edit, move, or delete anything in this folder.** Only the owner changes review marks, through the Sonara Review panel.
- **Never touch the git stage.** No \`git add\`, \`git reset\`, \`git restore --staged\`, \`git stash\`, \`git apply --cached\`, or any other command that changes the index. Staging is the owner's decision.
- Reading these files is allowed: they tell you which changes the owner has already looked at.
- Any file you edit lands on \`new\` for the owner. Editing code the owner already accepted is allowed, but say so in your report: name the file and what you changed in the accepted part, so the owner knows what to re-read.
- To see what the owner accepted, run the read-only command line described below instead of reading the files of this folder by hand: the levels are an overlay of accepted copies on the git index, not a plain list of marks.

## Command line for AI agents (read-only)

The extension writes a launcher into this folder every time it opens the project, so it always points at the installed version. Run it from anywhere; it needs \`node\` on the PATH and prints JSON by default:

\`\`\`
.vscode/sonara/review/sonara-review levels
\`\`\`

On Windows run \`sonara-review.cmd\` from the same folder.

| Command | What it prints |
|---------|----------------|
| \`sonara-review levels\` | how many files and changes sit on every level |
| \`sonara-review list --level read\` | the files that have changes on that level, with the number of changes |
| \`sonara-review changes src/app.ts\` | the changes of one file, level by level: identifier, line range, label |
| \`sonara-review show src/app.ts --level read\` | the file content accepted up to that level |
| \`sonara-review diff src/app.ts --level read\` | the changes of that level alone, as a unified diff |

Options: \`--level <new|queued|read|verified|staged>\`, \`--format text\` for a human-readable answer instead of JSON, \`--project <dir>\` when you call the entry point without the launcher. A file is named by its path from the repository root, or by an absolute path.

Exit codes: \`0\` success, \`1\` wrong arguments, \`2\` unknown file or level, \`3\` no git repository, \`4\` the review data is being changed right now (the owner is moving levels - read again), \`5\` unexpected failure. With \`--format json\` a failure prints \`{"error": {"code": "...", "message": "..."}}\` and with \`--format text\` it writes the message to stderr.

How to use it:

- Before you change a file, \`changes <file>\` tells you which of its parts the owner has already accepted. Editing accepted code is allowed, but name it in your report, because the owner has to read it again.
- \`show <file> --level verified\` is the exact text the owner accepted. Compare it with the file on disk to see what you changed after the review.
- \`diff <file> --level new\` is everything nobody has looked at yet.
- Line numbers from \`changes\` count the lines of the file as \`show --level <the same level>\` prints it, not the lines of the file on disk. A created or deleted file also carries one whole-file change (\`isWholeFile\`) next to its line changes.
- \`kind\` is \`text\`, \`opaque\` (binary files and symbolic links) or \`special\` (submodules and unmerged files). For \`opaque\` and \`special\`, \`show\` prints a description instead of the bytes and \`diff\` prints one line per change.
- In JSON, \`show\` gives \`content\` with \`encoding\` - \`utf-8\`, or \`base64\` when the file is not valid UTF-8. With \`--format text\` it writes the bytes as they are.
- When a stored level of some other file cannot be read, the answer still comes with exit code 0 and carries \`unreadable\`: those files are shown from git only, exactly as the panel shows them. Asking about such a file itself fails with exit code 4.
- The command line only reads. It never writes in this folder, never runs a git command that changes anything, and cannot move a change to another level - only the owner does that, from the Sonara Review panel.

## How the owner works with it

The Sonara sidebar has a **Review** panel. It lists exactly the files git reports as changed, grouped by level, with \`files / changes\` per level.

- **Move Up**, **Move Down**, **Move to Level...** on a level, folder or file move all its changes on that level. Moving to \`staged\` stages them, moving down from \`staged\` unstages them.
- Clicking a file opens the changes of that level only, read-only: the left side is \`HEAD\` plus all levels above, the right side adds this level. **Open File** opens the real file.
- A single change is moved from that diff: the CodeLens above it, or the commands \`Sonara: Move Change Up\`, \`Sonara: Move Change Down\`, \`Sonara: Move Change to Level...\` for the change under the cursor.
- \`Sonara: Next New Change\` and \`Sonara: Previous New Change\` walk through everything on \`new\`.
- Staging and unstaging in the regular Source Control view keeps the levels. Committed parts leave the panel. After \`git stash\` and \`git stash pop\` (or \`apply\`) the levels come back if the files return byte-identical with the same mode, on the same commit, from the same stash.
- Moves refuse and refresh the list when the file, its staged version, \`HEAD\` or its review record changed after the list or diff was built.
- Every action is logged to the **Sonara Review** output channel. Bulk moves log one summary; per-file and per-git-process details are logged when the \`sonara.review.debugLog\` setting is on.

## Levels

Changes are split into hunks (one continuous edit in a file). Each hunk has one level. Levels form a stack on top of \`HEAD\`, from the closest to \`HEAD\` to the furthest:

| Level | Meaning | Where it is kept |
|-------|---------|------------------|
| \`staged\` (Staged Changes) | The hunk is in the git stage, the same as Staged Changes in Source Control. | the git index |
| \`verified\` | The owner checked the hunk and considers it correct. | this folder |
| \`read\` | The owner read the code but has not made sure it is correct. | this folder |
| \`queued\` | The owner noticed the hunk and queued it for review without reading the code. | this folder |
| \`new\` | The owner has not marked this hunk yet. | nowhere (absence of a mark) |

Each level is a stack layer on top of \`HEAD\`. The extension stores the exact accepted version of each file for three levels: \`R3\` (verified), \`R2\` (read), \`R1\` (queued). The git index is the \`staged\` layer on top of them and never erases them: code staged and later unstaged returns to the level it had.

Shown file states: \`D5 = HEAD\`, \`D4 = index\`, \`D3\` = \`R3\` applied over the index, \`D2\` = \`R2\` applied over \`D3\`, \`D1\` = \`R1\` applied over \`D2\`, \`D0\` = the working file. "Applied over" is a conservative three-way merge with \`indexBase\` (the staged version the levels were last written on) as the base; a place where the accepted version and the layer below disagree is shown on \`new\`. The changes of a level are the difference between its two neighbouring states: \`staged\` = D5 vs D4, \`verified\` = D4 vs D3, \`read\` = D3 vs D2, \`queued\` = D2 vs D1, \`new\` = D1 vs D0.

A file state is its existence, its mode and its content. A missing file and an empty file are different states, and so are a regular file, an executable file and a symbolic link with the same bytes. A change of mode, a file creation or a file deletion is its own change on a level, next to the line changes.

Any edit of a file lands on \`new\`; the accepted versions stay on their levels. Binary files are checked as a whole.

The module shows exactly the files git reports as changed (modified, deleted, staged, untracked and not ignored), except this folder.

## File layout

\`\`\`
review/
  sonara-review
  sonara-review.cmd
  files/
    <path relative to the repository root>.json
  dormant/
    <path relative to the repository root>.json
  blobs/
    <sha256>
  journal/
    <time>-<process>-<random>.json
  quarantine/
    files/<path relative to the repository root>.json.<time>
  blobs.lock/
    owner.json
\`\`\`

- \`sonara-review\`, \`sonara-review.cmd\` - the read-only launcher described above, rewritten by the extension whenever it opens the project.
- \`files/\` - accepted versions of files that are currently changed in git.
- \`dormant/\` - accepted versions of files that left the git change list (for example after \`git stash\`). A file is parked here only if a stash made after its last review, on the same commit, holds exactly its working state. The record comes back when the file reappears with that state while this stash still exists (or is popped in the same refresh), and is deleted when the stash is gone or \`HEAD\` changes.
- \`blobs/\` - exact copies of accepted text versions, named by the SHA-256 of their bytes. Identical copies are stored once; copies no longer referenced from \`files/\`, \`dormant/\` or \`quarantine/\` are deleted in the background.
- \`quarantine/\` - records that could not be read or were malformed, moved aside with the time they were found. Their files start again from \`new\`; the blobs they name are kept.
- \`journal/\` - the record of a move that is being saved: the review records before and after it and, when the move stages or unstages, the git index it writes. A move writes its journal, then the records, then replaces the git index. If VS Code stops in the middle, the next Sonara window finishes the move when the new index was already fully written, and otherwise restores the previous records.\n- \`blobs.lock/\` - a short-lived lock held while review records, copies or journals are written. It names the process that holds it; a lock of a running process on the same computer is never taken over, however long it stays.

## File record format

\`\`\`json
{
  "version": 5,
  "path": "src/app/order-service.ts",
  "baseHead": "3f1c...9a0e",
  "kind": "text",
  "frontiers": {
    "verified": { "content": "9b1d...04aa" },
    "queued": { "content": "41c7...8f02", "mode": "100755" }
  },
  "indexBase": { "content": "70aa...3c19", "mode": "100644" }
}
\`\`\`

- \`path\` - the source file path relative to the repository root.
- \`baseHead\` - the commit the accepted versions were made against. When \`HEAD\` changes, the versions are carried to the new commit: parts that went into the commit leave the levels, untouched parts keep their level, parts that diverged go to \`new\`. While a rebase, merge or cherry-pick is in progress this waits until it ends.
- \`kind\` - \`text\` or \`opaque\` (binary files and symlinks).
- \`frontiers\` - one entry per level whose accepted state differs from the level below: \`verified\` is R3, \`read\` is R2, \`queued\` is R1. Each entry has two independent parts, and a missing part equals the same part of the level below it:
  - \`content\` - for \`text\` a file name in \`blobs/\`, for \`opaque\` the SHA-256 of the file bytes (an absent file has the SHA-256 of empty bytes);
  - \`mode\` - \`100644\` regular file, \`100755\` executable file, \`120000\` symbolic link, or \`missing\` for an absent file.
- \`indexBase\` - the staged state (\`content\` and \`mode\`, same encoding) the levels were last written on. A missing part equals \`HEAD\`. \`verified\` below falls back to \`indexBase\`, not to the current \`HEAD\`: \`verified = frontiers.verified ?? indexBase ?? HEAD\`, \`read = frontiers.read ?? verified\`, \`queued = frontiers.queued ?? read\`, per part.

Older records are still read and written back as version 5 on the next change. Version 4 used the level names \`seen\` (now \`queued\`) and \`looked\` (now \`read\`). Version 3 also stored plain hash strings without modes: text hashes become \`content\` parts, an empty text version is ignored, opaque \`missing\` becomes \`mode: missing\`. A record with a version newer than 5 is left untouched.

Dormant records in \`dormant/\` have the same format plus \`worktreeState\` and \`indexState\` (the working file and staged states when the file left the change list: \`missing\`, or \`<mode>:<SHA-256 of the bytes>\` for the working file and \`<mode>:<git object id>\` for the staged version) and \`stashOid\`, the stash that holds the parked working state.
`;
