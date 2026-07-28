// How a read file is named. Shared, because both ends need it and neither can
// import the other: `@/server/viewed` reaches `node:sqlite` and would break the
// browser bundle, and the file list is React. Stating the format twice — once
// in each — is how the two quietly drift into disagreeing, and a mark that
// fails to come back is invisible until the reviewer re-reads a file they had
// already read. So it lives here, depends on nothing, and is imported by both.

/**
 * The two shas of a `ChangedFile`, narrowed to what a mark needs. Structurally
 * satisfied by `ChangedFile` and by `blob.ts`'s `BlobRequest`, so a caller
 * passes the row it already has rather than a translation of it.
 */
export interface ViewedContent {
  readonly objectId: string | null
  readonly originalObjectId: string | null
}

/**
 * Which sha a mark hangs on, or `null` for a change entry with content on
 * neither side.
 *
 * `objectId` — the after-side blob — answers for an add, an edit and a rename.
 * **A delete has none**: T-015 measured `objectId` absent on 16 of 16 deletes on
 * !24766, and a mark that could not be made on a deleted file would leave a hole
 * in the progress count exactly where a reviewer is most likely to skim. What
 * they read there is the content going away, so the before-sha stands in for it,
 * and the ticket's property survives intact — rebase onto a base where that file
 * held different bytes and `originalObjectId` moves, un-viewing it.
 *
 * `null` is reachable only for an entry with no blob at all, which `loadFiles`
 * already filters (folders) and which live payloads have never produced. It is
 * returned rather than thrown so the caller decides, and `viewed-fn.ts` rejects
 * it at the edge.
 */
export function contentId(file: ViewedContent): string | null {
  return file.objectId ?? file.originalObjectId
}

/**
 * The key a marked file is recognised by, and the string `listViewed` returns.
 *
 * `${objectId}:${path}` needs no escaping: an object id is validated as forty
 * hex digits, so the first colon is the separator however many the path
 * contains. Lower-cased because ADO returns shas uppercase but the route params
 * a key is rebuilt from have been through a URL — one mark written under
 * `21C62CD8…` and looked up under `21c62cd8…` is a mark silently lost, which is
 * worse than the wasted blob fetch the same mismatch costs `blob_cache`.
 *
 * **The path is in the key, which bounds "content, not path" deliberately.** Key
 * on content alone and two files holding identical bytes — an empty file, a
 * generated stub, a copied header — collapse into one mark, so ticking either
 * ticks both, and that is a wrong answer the reviewer can see on screen. The
 * price is that a **pure rename un-views the file**: `objectId ===
 * originalObjectId`, the bytes did not move, but the path did and the old key no
 * longer matches. That is the outcome to want. T-015 records a pure rename as
 * the one case where "unchanged" is right about the content while being wrong
 * about the file, and T-016 makes the view say so out loud; a file that has just
 * started claiming to live somewhere else is worth the second glance.
 */
export function viewedKey(objectId: string, path: string): string {
  return `${objectId.toLowerCase()}:${path}`
}

/**
 * The same key straight from a change entry, which is the form the file list has
 * — it holds `ChangedFile` rows, not resolved shas. `null` for the entry with no
 * blob on either side, the one `markViewed` refuses.
 */
export function fileViewedKey(file: ViewedContent & { readonly path: string }): string | null {
  const objectId = contentId(file)
  return objectId === null ? null : viewedKey(objectId, file.path)
}
