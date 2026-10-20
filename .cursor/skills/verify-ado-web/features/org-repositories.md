# Org repositories

The org repositories page lists every repository in the ADO organization in one flat list, with name, project and default branch. The user searches the list, copies a clone URL, and opens a repository in the ADO web UI. There is no file browser and no "last updated" column.

## Sub-features

- `org-list` lists all repositories across all projects in one call.
- `org-search` filters the list by name or project.
- `org-copy` copies the clone URL to the clipboard.
- `org-open` opens the repository in ADO in a new tab.

## How to get to it (user POV)

- Choose the `org repositories` link in the inbox header or on `/repos`, or open `/org-repos`.
- Press `j` and `k` to move through the list.

## Driving it with drive.mjs

Preconditions:

- The run uses the default keyring service `ado-web`, and the ADO credential is present.

- **List.** Open `/org-repos`. Wait for the region named `Organisation repositories`. Its list has an accessible name of the form `Repositories, <shown> of <returned>`.
- **Search.** Fill the field named `Search repositories` with part of a known repository name. The shown count goes down, and the matching row stays.
- **Copy.** Grant clipboard permission first: `page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: url })`. Choose the button named `Copy clone URL for <name>`. Read `navigator.clipboard.readText()` in the page. The text starts with `https://dev.azure.com/`.
- **Open.** The row name is a link with `target="_blank"` to the ADO web URL. Its `title` ends with `open in Azure DevOps`. Assert on its `href`, or press `Enter` on the selected row and catch the new tab with `page.context().waitForEvent('page')`. Close the tab without signing in.

## Gotchas

- The organization has about 114 repositories, and 11 are disabled. Assert on a repository that the user names, not on a fixed count.
- The ADO clone URL is always the `dev.azure.com` form. Old local clones can use `{org}.visualstudio.com`. This list does not join with `/repos`.
- The open control leaves the app. Never sign in or act in the ADO tab.
