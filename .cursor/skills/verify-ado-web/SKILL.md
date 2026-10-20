---
name: verify-ado-web
description: Launch an isolated copy of ado-web (the local Azure DevOps pull request review web app), drive its pages in Chrome with Playwright, and capture screenshots, traces and server-function logs as proof. Use it to prove that a change works in the real app, not only in unit tests, for the inbox, the pull request review view, connections, and the local and org repository pages.
---

# Verify ado-web

ado-web is a single-user TanStack Start web app on `127.0.0.1`. The browser UI is the only user surface. Server functions under `/_serverFn/` are the only path to Azure DevOps (ADO), SonarCloud, local `git`, and SQLite. Thus every proof drives the browser.

All helpers are Node scripts. Run them from the repo root. State lives under `%LOCALAPPDATA%\ado-web-verify\`:

| Path | What it holds | Cleanup |
|---|---|---|
| `runs/<stamp>-<port>/run.json` | The run record: pid, port, URL, dirs | Kept |
| `runs/<stamp>-<port>/server.log` | Vite and server output | Kept |
| `runs/<stamp>-<port>/evidence/` | Proof from every drive | Kept |
| `runs/<stamp>-<port>/data/` | SQLite (`ADO_WEB_DATA_DIR`) | Removed |
| `runs/<stamp>-<port>/repos/` | Fixture git repos (`ADO_WEB_REPOS_ROOT`) | Removed |
| `vite-cache-<port>/` | Vite dependency cache | Kept, reused |
| `tools/` | `playwright-core@1.63.0` | Kept, reused |
| `latest.json` | Points at the newest run | Kept |

## Rules

- Never drive, stop or restart port `7331`. It is the user's own `pnpm dev`. The helpers refuse it.
- Never run `vite dev` by hand. The default cache `node_modules/.vite` is shared with the user's server, and a second server re-optimizes into it. `launch.mjs` gives each port its own cache.
- Never run `pnpm build` for verification. It rewrites `.output/`.
- The default run uses the user's real ADO and Sonar credentials (keyring service `ado-web`). Reads against ADO are safe.
- CAUTION: Do not press a write control without approval from the user for that exact action. Writes go to the real ADO organization: vote, comment, resolve, like, rename, add reviewer, attach work item, requeue, abandon, reactivate, squash merge. The squash merge also deletes the source branch.
- If the user approves a write, use a pull request that the user names. Read `evidence/writes.jsonl` afterward as side-effect proof.

## Launch

```sh
node .cursor/skills/verify-ado-web/scripts/launch.mjs
```

Options:

- `--port <n>`: the port. The default is `7341`. Each port gets its own Vite cache, so two runs on two ports do not collide.
- `--repos <dir>`: scan this directory for the local repository pages. The default builds a fixture under the run dir: repo `sample`, branch `feature/verify`, two commits ahead of `main`, no remote. A directory that you pass in is never deleted.
- `--fresh-credentials`: use an empty keyring service `ado-web-verify-<stamp>`. The app then starts as "not connected". Use this to drive the connections page. `stop.mjs` deletes this service.

The script waits until `GET /` answers 200 and `/__launch-token` hands out a 64-hex token. Then it prints the run record and `READY http://127.0.0.1:<port>`. A cold cache takes about 40 s. A warm cache takes about 2 s. If it does not print `READY` in 180 s, read `server.log`, then run `stop.mjs`.

## Doctor

```sh
node .cursor/skills/verify-ado-web/scripts/doctor.mjs
```

Run it first whenever something looks wrong. It is read-only. Exit 0 means the instance is worth driving. It does these checks:

- The run is not stopped, and the pid is alive.
- The port listener is our pid, not some other process.
- `GET /` answers 200, and the launch token arrives.
- The credentials for the run's keyring service are present or absent (values are never printed).
- `git` is on `PATH`.
- Port `7331` has a listener (INFO only, as a reminder not to drive it).

## Drive

```sh
node .cursor/skills/verify-ado-web/scripts/drive.mjs .cursor/skills/verify-ado-web/drives/local-branch-diff.mjs
```

`drive.mjs` installs `playwright-core` into `tools/` on the first use. It starts the installed Chrome (`channel: 'chrome'`, Edge as fallback), headless at 1440x900. Add `--headed` to see the browser. Add `--run <runDir>` to drive a run other than the newest.

A drive script is an `.mjs` file that default-exports one async function:

```js
export default async ({ page, url, run, shot, note, expect }) => {
  await page.goto(`${url}/repos`)
  await page.locator('[data-repo-slug="sample"]').waitFor()
  await shot('repos-list')             // numbered PNG in the evidence dir
  expect(true, 'what this proves')     // throws on false, logs "ok:" on true
  note('free text for steps.md')
}
```

- `page` is a Playwright `Page`. `run` is the run record (`run.reposRoot`, `run.dataDir`, `run.writeLedger`).
- Put new drive scripts in `.cursor/skills/verify-ado-web/drives/`.
- Use the handles in `features/`. Prefer `getByRole` with an accessible name, `data-pr-id`, and `data-repo-slug`. Do not use coordinates or tab order.
- Wait for a named element, not for a fixed time. The inbox and the diff load in stages.
- The app has keyboard commands (`j`, `k`, `Enter`, `?`, `t`, `b`). They do nothing while a text field has focus.

## Evidence

Each drive writes `runs/<run>/evidence/<stamp>-<script>/`:

- `NN-<name>.png`: one screenshot per `shot()`.
- `steps.md`: each `note()` and each `expect()` in order.
- `server-fns.jsonl`: each server-function call with its name and HTTP status, for example `{"fn":"repositoriesQuery","status":200}`.
- `console.log`: browser console output and page errors.
- `trace.zip`: the Playwright trace. Open it with `npx playwright@1.63.0 show-trace <path>`.
- `summary.json`: `ok`, the failure stack, and the evidence path.
- `failure.png`: present only if the drive failed.

The run-level `evidence/writes.jsonl` records every ADO write and the re-read after it (`ADO_WEB_WRITE_LEDGER`). It sends nothing itself.

Proof standards:

- Drive the real user path: links, buttons and keys. Do not call server functions directly, and do not set state through devtools.
- Capture the action and the state after it, not only the final screen.
- Make sure that side effects are real. Look at the fixture repo with `git`, at `run.dataDir` SQLite, or at `writes.jsonl`. For a read-only feature, prove that nothing changed: `local-branch-diff.mjs` compares `HEAD` and the `.git/index` mtime before and after.
- If a feature file lists more than one entry point, drive each one. A proof through one convenient path is incomplete.
- Look at the screenshots before you report. A 200 status with an empty page is not a pass.

## Cleanup

```sh
node .cursor/skills/verify-ado-web/scripts/stop.mjs
```

The script stops only the pid that `launch.mjs` started, with its child processes (`taskkill /T`). It never stops a process by name. Then it removes `data/`, the fixture `repos/`, and any fresh keyring service. It keeps `evidence/`, `server.log` and `run.json`, and prints the evidence path. Run it after every attempt, also after a failed attempt.

To find runs that were never stopped, look for a `run.json` without `stoppedAt` under `%LOCALAPPDATA%\ado-web-verify\runs\`. Then run `stop.mjs --run <runDir>` for each.

## Feature map

Read `features/README.md` before you drive. It lists each user-facing feature, its entry points, its handles, and its traps.
