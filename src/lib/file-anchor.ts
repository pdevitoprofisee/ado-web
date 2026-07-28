// Where a path is on the page. Shared because two components have to agree on
// it: the diff list writes the id onto each panel and the tree beside it looks
// one up by hand through `getElementById`, which is the whole reason this is one
// function and not two string templates.
//
// Not an `href="#…"`: the router owns the URL, and a hash landing in it would
// survive into the back button and the reload as a piece of state nobody meant
// to keep.

/**
 * An id for a path, safe to put in `id=`.
 *
 * Every character that is not a letter or a digit is encoded rather than swapped
 * for a dash, which looks worse and is the only version that works: dashing them
 * maps `/src/foo-bar.ts` and `/src/foo/bar.ts` onto the same id, and a sidebar
 * that scrolls to the wrong file is harder to notice than one that does nothing.
 */
export function fileAnchor(path: string): string {
  return `file${path.replace(/[^a-zA-Z0-9]/g, (char) => `_${char.charCodeAt(0).toString(36)}_`)}`
}
