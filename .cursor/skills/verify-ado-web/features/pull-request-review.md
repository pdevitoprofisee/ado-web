# Pull request review

The review page shows one pull request: title, description, branches, conflict state, policies, reviewer votes, commits, checks, Sonar findings, and one virtualized diff of all files with comment threads inline. The user marks files viewed, finds text in the diff, and acts on the pull request.

## Sub-features

- `pr-header` shows the title, description, branches, conflict state and the policy checklist.
- `pr-diff` renders the files, unified or side by side, with whitespace ignored or not.
- `pr-files` lists the files in a tree named `File tree` and moves between them.
- `pr-viewed` marks a file viewed. The mark is local SQLite, keyed on the file content.
- `pr-find` finds text in the diff, with `Previous match` and `Next match`.
- `pr-threads` shows comment threads inline. Done threads collapse to a one-line stub.
- `pr-checks` shows build steps, the failing step log, and failed tests.
- `pr-sonar` groups Sonar findings by rule and jumps from an occurrence into the diff.
- `pr-writes` votes, comments, resolves, renames, adds reviewers, attaches work items, requeues, abandons, reactivates, and squash merges. All of these write to ADO.

## How to get to it (user POV)

- Choose a row in the inbox, or press `Enter` on the selected row.
- Open `/pr/<projectId>/<repositoryId>/<prId>`.
- Choose a pull request in `/history` (closed pull requests).
- Choose a notification in the notifications panel.

## Driving it with drive.mjs

Preconditions:

- The run uses the default keyring service `ado-web`, and the ADO credential is present.
- The user names the pull request to use. Get its route from the inbox row link, `[data-pr-id="<id>"] a`.

- **Open.** Go to the pull request route. Wait for the list named `Changed files`. The title shows in the header. A rename control is named `Rename this pull request`.
- **Files.** Press `]` and `[`. The current file moves forward and back. The tree named `File tree` marks the current file.
- **Layout.** In the group named `Diff layout`, choose `Side by side`, then `Unified`. Choose `Ignore whitespace` and see that the diff changes for a whitespace-only hunk.
- **Viewed.** Press `v` on a file, or check its `Viewed` box. The count `<n> of <m> read` goes up by one. Reload, and the mark stays. Prove the write with `SELECT path FROM viewed_file` on `<run.dataDir>/ado-web.db` (`node:sqlite`).
- **Find.** Press `/`. Type a word from the diff. Choose `Next match` and `Previous match`. The match moves and scrolls into view.
- **Threads.** Press `n` and `p` to move through unresolved threads.
- **Checks.** Open the region named `Checks`. A failed build shows the region `Failed tests` and the failing step log.
- **Sonar.** Open the region named `Sonar`. The list `Findings by rule` groups findings. Choose an occurrence, and the diff scrolls to that line. Press `}` and `{` to move between findings.
- **Writes.** Ask the user before each one. The vote group is named `Your vote`, with `Approve`, `Approve with suggestions`, `No vote`, `Wait for author` and `Reject`. The merge button is `Squash and merge`, and it opens a dialog titled `Squash and merge?`. After an approved write, read `<run.evidenceDir>/writes.jsonl` and reload the page to prove the new state.

## Gotchas

- CAUTION: `Squash and merge` merges into the target branch and deletes the source branch. Never press it without approval from the user for that exact pull request.
- A vote to a person who is not a reviewer adds them as a reviewer. The app refuses this case, but only after a re-read.
- The diff is virtualized. A line far down the file is not in the DOM until it scrolls into view. Use `Find`, `]`, or a Sonar jump to reach it, not a DOM query.
- A line inside collapsed context has no row until its gap expands.
- The thread poll runs about every 30 s and rebuilds the diff rows. Wait for a named element again after a poll.
- Viewed marks are local to `run.dataDir`. They do not show in the user's own instance, and they are gone after `stop.mjs`.
