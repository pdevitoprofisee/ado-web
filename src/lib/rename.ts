import { useQueryClient } from '@tanstack/react-query'

import { INBOX_KEY, retitleInboxRow } from './inbox-cache'
import { pullRequestKey } from './requeue'
import { renamePullRequest } from '@/server/pull-request-fn'

import type { PullRequestRef } from '@/server/pull-request'

// The header's one write: give this pull request a different title.
//
// A promise the caller awaits rather than a `useMutation` like `useRequeue`, and
// the difference is where the state belongs. A requeue's outcome is a *row* in a
// checklist the page draws, so the mutation is the row's state. A rename happens
// inside a field, and a field's busy-and-error state is the field's own — this is
// exactly `Composer`'s contract, down to the reason for it: resolve and the
// editor closes, reject and it keeps every character with the sentence
// underneath. Losing a title you typed because Azure DevOps refused it is the
// worst outcome available here.
//
// Nothing is optimistic, for `conversation.ts`' reason. The stored title is the
// one thing the header is *for*, so showing the typed one while the write is out
// would mean a header that says the rename worked before anybody knows.

/**
 * Renames the pull request, then waits for the page to have re-read it.
 *
 * Rejects with what ADO said — a refusal the server *returns* rather than throws
 * is still a failure the field has to report, and `ok` is the only field that
 * says so.
 */
export function useRename(ref: PullRequestRef): (title: string) => Promise<void> {
  const client = useQueryClient()

  return async (title: string) => {
    try {
      const result = await renamePullRequest({ data: { ...ref, title } })
      if (!result.ok) throw new Error(result.error ?? 'Azure DevOps did not say why.')

      // The header is not the only place this name is drawn. The inbox holds its
      // own copy of the row and re-reads it every two minutes, so without this
      // the table you go back to keeps the old title for as long as that takes.
      retitleInboxRow(client, ref.id, title)
    } finally {
      // Re-read on failure as well as on success, `useRequeue`'s rule and for its
      // reason: a write that timed out on the way back may well have been applied
      // (`ado-client.ts` note 2), and the re-read is the only thing that knows
      // whether the title changed. A header stuck on the old title because the
      // write reported a failure it half-completed is the one outcome nothing else
      // here would correct.
      //
      // Awaited, so the field stays busy until the heading it is about to become is
      // the one ADO holds. Closing a beat earlier means the old title is still on
      // screen when the editor disappears, which reads as a rename that did
      // nothing.
      await client.invalidateQueries({ queryKey: pullRequestKey(ref) })

      // The inbox as well, and for the same reason as the line above: a refused
      // write can still have landed, and the row above is only written on the
      // success path. Not awaited — the inbox is not on screen, and an org-wide
      // list call is not something the field can stay busy through. It is
      // inactive here, so this marks it stale and the table reads it on arrival.
      void client.invalidateQueries({ queryKey: INBOX_KEY })
    }
  }
}
