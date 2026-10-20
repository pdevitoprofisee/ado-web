# Local repositories

The user sees every git repository one level under `ADO_WEB_REPOS_ROOT`, with its current branch and its diff target. The user opens a repository to read the whole-branch diff against the target, walks the branch history, and opens one commit's diff. Nothing on these pages calls ADO or writes to a repository.

## Sub-features

- `repos-list` lists each repository with its current branch and the target rung.
- `repos-branch-diff` shows the changed files and the diff of the branch against its target.
- `repos-history` lists the branch commits, 50 per page.
- `repos-commit` shows one commit's diff, and names the parent for a merge.
- `repos-read-only` leaves `HEAD`, `.git/index` and the working tree unchanged.

## How to get to it (user POV)

- Choose the `repositories` link in the inbox header, or open `/repos`.
- Choose a repository name in the list, or open `/repos/<slug>`.
- Choose the `commits` link in the branch diff header, or open `/repos/<slug>/commits`.
- Choose a commit in the history, or open `/repos/<slug>/commit/<sha>`.
- Press `j` and `k` to move through the repository list, and `Enter` to open one.

## Driving it with drive.mjs

Preconditions:

- The run uses the default fixture: repo `sample` on `feature/verify`, two commits ahead of `main`, no remote.
- `doctor.mjs` exits 0.

- **List.** Open `/repos`. Wait for `[data-repo-slug="sample"]`. The row contains `feature/verify` and `main`. The footer names `run.reposRoot`.
- **Branch diff.** Click `[data-repo-slug="sample"] a`. The URL becomes `/repos/sample`. The list named `Changed files` contains `app.js` and `notes.md`. The diff shows `verify-marker`. The header reads `feature/verify → main` and "a local branch — this repository has no origin".
- **History.** Click `a[href$="/repos/sample/commits"]`. The page lists `docs: add notes` and `feat: change the greeting`.
- **One commit.** Click a commit in the history. The URL becomes `/repos/sample/commit/<sha>`. The diff shows only that commit's files.
- **Read-only proof.** Before and after the drive, record `git rev-parse HEAD` and the mtime of `.git/index` in the fixture. Both are unchanged. Compare the mtime before you run `git status`, because `git status` can write the index.
- **Script.** `node .cursor/skills/verify-ado-web/scripts/drive.mjs .cursor/skills/verify-ado-web/drives/local-branch-diff.mjs` covers the list, the branch diff, the history and the read-only proof.

## Gotchas

- The list is re-read on window focus and is never cached. A new repo in the fixture shows after a reload.
- Two repositories with the same directory name under two roots cannot be opened. The row says so.
- The app never fetches. A target of `origin/main` is only as new as the last fetch in that repo.
- The `Viewed` checkbox on the branch diff writes to SQLite in `run.dataDir`. There are no viewed marks on a single commit.
- A merge commit diffs against one parent. The page names that parent and links the others.
