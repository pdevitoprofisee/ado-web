import { useMutation, useQueryClient } from '@tanstack/react-query'

import { squashMerge } from '@/server/pull-request-fn'

import { pullRequestKey } from './requeue'

import type { PullRequestDetail, PullRequestRef } from '@/server/pull-request'

// The page's other write: complete the pull request, squashed, with a commit
// message the reviewer wrote and the source branch deleted.
//
// **Nothing here is optimistic**, for a harder reason than `requeue.ts`' one.
// Whether the merge happened is Azure DevOps' answer, not ours — it re-checks
// every policy and re-compares the source tip after we ask — so drawing the PR
// as completed before it says so would be inventing the one fact the reviewer
// came to the page to establish. The page goes quiet, the write goes out, the
// page re-reads.

/**
 * The two halves of a git commit message, as two fields on the page.
 *
 * Two strings rather than one textarea because they are not the same kind of
 * writing: the subject is the line every `git log --oneline` and every ADO commit
 * list shows, the body is everything else. Splitting them is what lets the
 * subject be a single-line input that cannot accidentally grow a second line.
 */
export interface CommitDraft {
  readonly subject: string
  readonly body: string
}

/**
 * What the fields say before anyone types: Azure DevOps' own squash convention.
 *
 * `Merged PR {id}: {title}` is the subject ADO writes when it composes the
 * message itself, and the description is the body it uses. Copying it is the
 * point — this page now sends the message explicitly, and a repository's history
 * should not change shape depending on which client merged. It is a starting
 * text, not a rule: every character of it is editable.
 */
export function defaultDraft(pr: Pick<PullRequestDetail, 'id' | 'title' | 'description'>): CommitDraft {
  return { subject: `Merged PR ${pr.id}: ${pr.title}`, body: pr.description }
}

/**
 * The draft as one commit message: subject, blank line, body.
 *
 * The blank line is the whole reason this is a function. Git reads the first
 * paragraph as the subject, so a message without it is one long subject line, and
 * every tool that shows a shortlog would show the body too. An empty body means
 * the subject alone, with no trailing blank line to pad the commit.
 *
 * Ends trimmed only: what someone typed *inside* the body is theirs, including
 * blank lines between paragraphs and the indentation of a pasted stack trace.
 */
export function commitMessage(draft: CommitDraft): string {
  const subject = draft.subject.trim()
  const body = draft.body.trim()

  return body === '' ? subject : `${subject}\n\n${body}`
}

/** One button's worth of state: what pressing it does, and what came back. */
export interface SquashMerge {
  /**
   * Sends the completion.
   *
   * One object, not two positional strings: a sha and a commit message are both
   * strings, and swapping them at the call site would type-check and merge.
   */
  readonly run: (completion: { lastMergeSourceCommit: string; commitMessage: string }) => void
  readonly isPending: boolean
  /**
   * What Azure DevOps said, verbatim, or `null`.
   *
   * Verbatim on purpose: a refused completion names the policy, or says the
   * source branch has been updated, and no sentence of ours could carry that.
   * Cleared by `dismiss` so a closed-and-reopened dialog does not still show the
   * last attempt's refusal.
   */
  readonly error: string | null
  readonly dismiss: () => void
}

/**
 * @param onMerged Run once, after the re-read, when ADO accepted the merge — the
 * caller's cue to close its confirmation. Here rather than in the component so
 * the dialog cannot close on a write that failed.
 */
export function useSquashMerge(ref: PullRequestRef, onMerged: () => void): SquashMerge {
  const client = useQueryClient()

  const mutation = useMutation({
    mutationFn: async (completion: { lastMergeSourceCommit: string; commitMessage: string }) => {
      const result = await squashMerge({ data: { ...ref, ...completion } })
      // The server function answers a refusal rather than throwing one; react-query
      // only calls something a failure if it rejects. Reconciled here, as in
      // `useRequeue`.
      if (!result.ok) throw new Error(result.error ?? 'Azure DevOps did not say why.')
    },
    // On failure too: a completion whose response was lost may well have merged
    // (`ado-client.ts` note 2), and only the re-read knows. Awaited, so what the
    // reviewer sees next is the pull request's real state rather than the state it
    // had when they pressed.
    onSettled: () => client.invalidateQueries({ queryKey: pullRequestKey(ref) }),
    onSuccess: onMerged,
  })

  return {
    run: (completion) => mutation.mutate(completion),
    isPending: mutation.isPending,
    error: mutation.error === null ? null : mutation.error.message,
    dismiss: () => mutation.reset(),
  }
}
