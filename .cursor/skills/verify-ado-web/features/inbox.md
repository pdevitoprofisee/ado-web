# Inbox

The inbox is the home page. It lists the user's active pull requests in two sections, `Mine` and `Assigned to me`, with check state, comment counts and staleness. The user can search, change the row layout, refresh, open the notifications panel, and open the history of closed pull requests.

## Sub-features

- `inbox-sections` shows `Mine` first, then `Assigned to me`, which includes pull requests assigned to a team of the user.
- `inbox-hydrate` fills check state and comment counts per row, visible rows first.
- `inbox-search` filters rows by title, repository or description.
- `inbox-toggles` switches `Two-line rows` and `Group by repository`. Both persist.
- `inbox-refresh` forces a fresh answer with the `Refresh` button.
- `inbox-not-connected` shows "Not connected yet" with no ADO credential.
- `notifications` opens the slide-over panel with unread state and a mute toggle.
- `history` lists the user's completed and abandoned pull requests at `/history`.

## How to get to it (user POV)

- Open `/`.
- Press `j` and `k` to move between rows, `Enter` to open the selected pull request.
- Press `b`, or choose the button named `Notifications`, to open the notifications panel.
- Choose the `history` link in the header, or open `/history`.
- Press `t`, or choose `Switch to light mode` / `Switch to dark mode`, to change the theme.

## Driving it with drive.mjs

Preconditions:

- The run uses the default keyring service `ado-web`, and `doctor.mjs` shows `ado-web/azure-devops (present)`.
- The user has at least one active pull request in the ADO organization.

- **Load.** Open `/`. Wait for the text `Loading the inbox…` to go. A section titled `Mine` and a section titled `Assigned to me` appear. Each section heading has an accessible name of the form `<title>, <count>`.
- **Rows.** Rows carry `data-pr-id="<id>"`. Each row has one link to `/pr/<projectId>/<repositoryId>/<id>`.
- **Search.** Fill the text field named `Search pull requests by title, repository or description` (match the start, `Search pull requests by`). Only matching rows stay. Clear it, and all rows return.
- **Toggles.** Click the toggle buttons `Two-line rows` and `Group by repository`. Each holds `aria-pressed="true"`. With grouping on, section names have the form `<repo>, <n> pull requests`. Reload and confirm that the toggles keep their state.
- **Refresh.** Click `Refresh`. The label reads `Refreshing…`, then `Refresh`. `server-fns.jsonl` shows a new `inboxQuery` call.
- **Keyboard open.** Press `j`, then `Enter`. The URL becomes the pull request route of the selected row.
- **Notifications.** Press `b`, or choose the button named `Notifications` (`Notifications, <n> unread` when there are unread items). A dialog titled `Notifications` opens, with the toggle `Mute notification sounds`. Close it with the button `Close notifications`.
- **History.** Click the `history` link. The heading reads `History`, and one section titled `Closed` lists the closed pull requests. It has a `Refresh` button and no poll.
- **Not connected.** Launch with `--fresh-credentials` and open `/`. An alert titled `Not connected yet` links to `connections`.

## Gotchas

- Every load reads the real ADO organization through the user's PAT. ADO throttles with slow HTTP 200 responses, not 429. A slow inbox is not always a fault.
- The inbox polls about every 2 minutes, and the poll writes notification state to SQLite in `run.dataDir`. A fresh data dir primes silently, so the first poll plays no sounds and adds no notifications.
- Row contents depend on live ADO data. Assert on structure and on a pull request that the user names, not on fixed counts.
- The search box is not autofocused. Keyboard commands do not work while it has focus.
