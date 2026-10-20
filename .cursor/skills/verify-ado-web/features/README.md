# ado-web verification map

This directory is the maintained source for verifying the user-facing behavior of ado-web. Read this index before you drive the app. Then use the matching feature file as the recipe.

## Baseline preconditions

- Start the instance with `node .cursor/skills/verify-ado-web/scripts/launch.mjs`. It answers at `http://127.0.0.1:7341` by default.
- `doctor.mjs` exits 0.
- The default run reads the user's real ADO and Sonar credentials. The connections feature needs `--fresh-credentials` instead.
- The local repository pages scan the fixture under `run.reposRoot`, unless the launch used `--repos`.
- Never drive port `7331`. It is the user's own instance.

## Driving conventions

- Write each recipe as a drive script in `../drives/` and run it with `scripts/drive.mjs`.
- Prefer ARIA roles and accessible names (`getByRole('list', { name: 'Changed files' })`). Then `data-pr-id` and `data-repo-slug`. Never coordinates.
- Wait for a named element after each navigation. Do not sleep for a fixed time.
- Keyboard commands do nothing while a text field has focus. Press `Escape` or click the page body first.
- Do not press an ADO write control without approval from the user for that action.

## Proof and skip reporting

- Capture the user action and the state after it, not only the final screen.
- Each proof includes the screenshots, `steps.md`, and `server-fns.jsonl` from the evidence dir.
- Local writes (viewed marks, notification read state) are proven by a query on `<run.dataDir>/ado-web.db`.
- ADO writes are proven by `<run.evidenceDir>/writes.jsonl` and by a reload of the page.
- If an entry point cannot be reached, report the attempted step and the missing precondition. Do not report it as verified through a different path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph about the user-visible behavior. It then has exactly four H2 sections in this order: `Sub-features`, `How to get to it (user POV)`, `Driving it with drive.mjs`, and `Gotchas`.

## Features

- [Local repositories](./local-repositories.md): the repository list, the whole-branch diff, the commit history, and one commit's diff. No ADO call. Proven by `drives/local-branch-diff.mjs`.
- [Inbox](./inbox.md): the `Mine` and `Assigned to me` sections, search, row toggles, refresh, notifications, and history.
- [Pull request review](./pull-request-review.md): the diff, the file tree, viewed marks, find, checks, Sonar, and the write controls.
- [Connections](./connections.md): the onboarding page that tests and saves the ADO and Sonar tokens.
- [Org repositories](./org-repositories.md): the searchable list of every repository in the ADO organization.
