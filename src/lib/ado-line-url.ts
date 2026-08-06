// **The one guessed URL in this application.** Every other address the app
// links out to is a field Azure DevOps handed us. This one is reasoned out from
// the shape of the URLs its web UI writes, and nobody has opened one in a
// browser.
//
// UNPROVEN, and deliberately the only place that is. If a link from the diff
// opens the file at the top instead of at the line — or the overview instead of
// the files — this function is where it is wrong, and it is the whole of what
// has to change.
//
// What it assumes, each of which is one thing a reader with a real pull request
// in front of them can check:
//   - `_a=files` selects the Files tab.
//   - `path` is the repository-absolute path, `/src/log.ts`, encoded.
//   - `line` is where the selection starts and `lineEnd` is the line after it —
//     ADO's half-open way of selecting one whole line.
//   - `lineStartColumn` and `lineEndColumn` are both 1, which is what "the whole
//     line, from its first column" means under that convention.
//   - `lineStyle=plain` is the ordinary highlight, as against `error`.
//
// There is no test over this shape. One would assert the guess against itself,
// pass, and then read to the next person as evidence the shape is right.

/**
 * Where one line of one file in a pull request lives in Azure DevOps.
 *
 * `webUrl` is the pull request's own `url`, reused rather than re-derived so the
 * organisation and the project are spelled in exactly one place — `pull-request.ts`.
 */
export function adoLineUrl(webUrl: string, path: string, line: number): string {
  const url = new URL(webUrl)

  // `set` rather than a `?…` template: a `webUrl` that already carries a query is
  // not something this function should be able to break.
  for (const [name, value] of [
    ['_a', 'files'],
    ['path', path],
    ['line', String(line)],
    ['lineEnd', String(line + 1)],
    ['lineStartColumn', '1'],
    ['lineEndColumn', '1'],
    ['lineStyle', 'plain'],
  ] as const) {
    url.searchParams.set(name, value)
  }

  return url.toString()
}
