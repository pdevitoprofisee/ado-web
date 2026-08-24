import { useMutation, useQueryClient } from '@tanstack/react-query'

import { setSquashStrategy, squashMerge } from '@/server/pull-request-fn'

import { pullRequestKey } from './requeue'

import type { PullRequestDetail, PullRequestRef, Reviewer } from '@/server/pull-request'

// The page's other write: complete the pull request, squashed, with a commit
// message the reviewer wrote and the source branch deleted.
//
// **Nothing here is optimistic**, for a harder reason than `requeue.ts`' one.
// Whether the merge happened is Azure DevOps' answer, not ours — it re-checks
// every policy and re-compares the source tip after we ask — so drawing the PR
// as completed before it says so would be inventing the one fact the reviewer
// came to the page to establish. The page goes quiet, the write goes out, the
// page re-reads.
//
// `mergeBlocker` is here rather than beside one of the two places that draw the
// button, because both of them ask it — the detail page and the inbox row — and a
// second copy of "may this merge" is a second copy that can drift.

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
 * What the fields say before anyone types: the pull request's own title and
 * description, unchanged.
 *
 * **Not `Merged PR {id}: {title}`, which is what Azure DevOps writes when it
 * composes the message itself.** That prefix pushes the title past the first
 * ten characters of every shortlog, and it destroys a Conventional Commits
 * subject: a pull request called `feat(inbox): merge from the table` lands in
 * `main` as a commit no parser reads as a feature. Titles here are already
 * written as commit subjects, so the honest default is to keep them.
 *
 * Nothing is added in the prefix's place. The type and the scope are the
 * author's to write, and a fallback of `chore:` would file every unlabelled
 * pull request under a lie. The pull request number is dropped with it —
 * Azure DevOps links the squashed commit to its pull request on its own.
 *
 * It is a starting text, not a rule: every character of it is editable.
 */
export function defaultDraft(pr: Pick<PullRequestDetail, 'title' | 'description'>): CommitDraft {
  return { subject: pr.title, body: pr.description }
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

/**
 * Which sections came back empty because their fetch failed rather than because
 * there is nothing in them — an empty array cannot say which, and only one of
 * the two means the section can be trusted.
 *
 * `pullRequestDetail({...}).failed` from `pull-request-fn.ts` is assignable
 * straight to this, so the route hands it over untranslated. Optional here so a
 * section still renders standalone, plain, in a test.
 *
 * Reviewers and conflict state are absent because they ride on the detail call,
 * the page's one hard dependency. The conflicting *paths* can fail on their own
 * and are read from `pr.errors.conflicts` instead.
 */
export interface FailedSections {
  readonly policies?: boolean
  readonly commits?: boolean
  readonly files?: boolean
}

/** ADO says `refs/heads/foo`; nobody else does. */
export function branch(ref: string): string {
  return ref.replace(/^refs\/heads\//, '')
}

/**
 * ADO's words for "nobody has attempted this merge yet". Neither was seen once
 * in 21,133 live PRs, and an empty `status` — ADO having omitted the field — is
 * deliberately not in here: not saying is not the same as saying "not tested".
 */
export const UNTESTED = new Set(['queued', 'notSet'])

/**
 * A vote that counts as an approval.
 *
 * Both of ADO's approvals do — "approved with suggestions" satisfies a reviewer
 * requirement, which is the whole difference between it and "waiting for author".
 * So the test is `>=` against the lower of the two rather than a set of the
 * values that pass, and a sixth positive integer on the scale would count.
 */
const APPROVES = 5

/**
 * The required reviewers standing between this branch and its target, as a
 * sentence — or `null` when none are.
 *
 * **This is not in the policy list, and that is the bug it exists to fix.** On
 * PR 24949 all seven policy evaluations read `approved` while Azure DevOps' own
 * header said "Patrick Mize must approve": a reviewer marked required *on the
 * pull request* produces no evaluation at all, so a page that reads only
 * `policies` sees an entirely green checklist and offers a merge ADO will not
 * take. ADO's Complete button gates on policies **and** on these; so does this.
 *
 * Containers are counted the same way people are, because ADO rolls a member's
 * vote up onto the group: measured on the same pull request, `[Products]\
 * Contributors` carried `vote: 10` of its own once Chuck Thompson approved on its
 * behalf. Skipping groups would drop the requirement that a team look at this.
 *
 * Named while there are one or two, counted after that. "One required reviewer
 * has not approved" sends the reader off to find out who, and the payload already
 * knows; past two the names stop being a sentence.
 */
function awaitedReviewers(reviewers: readonly Reviewer[]): string | null {
  const names = reviewers
    .filter((reviewer) => reviewer.isRequired && reviewer.vote < APPROVES)
    .map((reviewer) => reviewer.displayName)

  if (names.length === 0) return null
  if (names.length === 1) return `${names[0]} is a required reviewer and has not approved.`
  if (names.length === 2) {
    return `${names[0]} and ${names[1]} are required reviewers and have not approved.`
  }

  return `${names.length} required reviewers have not approved.`
}

/**
 * Why this pull request cannot be squash-merged from here, or `null` when it can
 * be.
 *
 * A pure function, exported, and every branch is a whole sentence, because a
 * disabled button that will not say why is worse than no button at all — the
 * reason is drawn beside the control rather than left for the reviewer to guess.
 *
 * It answers "not from here", not "not possible". Azure DevOps re-checks every
 * one of these on the write and owns the real answer, so where this is unsure it
 * refuses: a policy list that failed to load and a source tip ADO did not name
 * both read as "we do not know", which is a reason to keep the button off.
 *
 * The order is the order the question is actually asked in — is this open, is it
 * still a draft, does it merge at all, do we know about the policies, do the
 * policies allow it, have the people who must approve approved, and do we know
 * what we would be merging.
 */
export function mergeBlocker(
  pr: Pick<
    PullRequestDetail,
    'status' | 'isDraft' | 'merge' | 'policies' | 'reviewers' | 'lastMergeSourceCommit'
  >,
  failed: FailedSections,
): string | null {
  if (pr.status !== 'active') {
    if (pr.status === 'completed') return 'This pull request has already been completed.'
    if (pr.status === 'abandoned') return 'This pull request has been abandoned.'

    // An unrecognised status is not narrowed into one of the two above: ADO's
    // word is shown as-is, because guessing which of them a fourth value means
    // is how a page tells somebody their merged PR is still open.
    return `Azure DevOps says this pull request is ${pr.status === '' ? 'in a state it did not name' : pr.status}, not active.`
  }
  if (pr.isDraft) return 'This is a draft. Publish it in Azure DevOps before merging.'
  // Ahead of the status because a conflicted PR *has* a status, `conflicts`, and
  // the conflict is the sentence worth saying. Same reason `MergeBanner` keys on
  // this flag rather than on the word.
  if (pr.merge.conflicted) return 'This branch conflicts with its target.'
  // Not the banner's sentence word for word, which is deliberate: the banner
  // reports the state, and a reason attached to a disabled control owes the
  // consequence as well. Repeating it verbatim would also put the same string on
  // the page twice, two lines apart.
  if (UNTESTED.has(pr.merge.status)) {
    return 'Azure DevOps has not tested this merge yet, so it cannot be completed from here.'
  }
  if (pr.merge.status !== 'succeeded') {
    return pr.merge.status === ''
      ? 'Azure DevOps did not say whether this branch merges cleanly.'
      : `Azure DevOps says the merge is ${pr.merge.status}.`
  }
  if (failed.policies === true) {
    return 'The branch policies could not be loaded, so whether this may merge is unknown.'
  }

  // `Policy.blocking` already means "required and not yet satisfied", so a
  // passing required policy does not count itself here.
  const blocking = pr.policies.filter((policy) => policy.blocking).length
  if (blocking > 0) {
    return blocking === 1
      ? 'One blocking policy is not satisfied yet.'
      : `${blocking} blocking policies are not satisfied yet.`
  }

  // After the policies, because a required reviewer is the same class of question
  // and the policy rows are the ones with a build behind them; before the source
  // tip, because "somebody still has to look at this" is the more useful sentence
  // of the two. The reviewers come from the detail call, which is this page's one
  // hard dependency, so there is no "did the list load" case to answer here.
  const awaited = awaitedReviewers(pr.reviewers)
  if (awaited !== null) return awaited

  if (pr.lastMergeSourceCommit === null) {
    return 'Azure DevOps did not say which commit the source branch is on, so merging from here could merge work this page never showed.'
  }

  return null
}

/**
 * How long Azure DevOps is given to re-judge the policy before the page re-reads.
 *
 * The PATCH is answered before the evaluation it changes has moved, which is
 * `requeue.ts`' finding about a queue and is true of this one too: the read taken
 * the instant the write returns is a read of a service that has not acted yet, and
 * the row comes back still red. So the page waits once, then re-reads.
 *
 * One wait and not `requeue.ts`' ladder of them, because there is no second thing
 * to learn here. The strategy either took or it did not, and a row that is still
 * red after two seconds is a row the reviewer can press Refresh on — where a
 * requeue is waiting on a build queue, whose length nobody here knows.
 */
const SETTLE_MS = 2_000

/** The one verb a merge strategy policy row has, and what came back. */
export interface SquashStrategy {
  /** Tells Azure DevOps this pull request is to be squashed. Merges nothing. */
  readonly ask: () => void
  readonly isPending: boolean
  /** What Azure DevOps said about the last attempt, or `null`. */
  readonly error: string | null
}

/**
 * Write the squash strategy onto the pull request, so that Azure DevOps' own
 * policy row agrees with this page's.
 *
 * **It changes nothing about what merging from here does.** The completion this
 * app sends already carries `mergeStrategy: 'squash'`, and a squash-only policy
 * does not stand in its way — measured. So this is offered as a control rather
 * than sent on load: the row it fixes is a row in the *Azure DevOps* web UI, the
 * pull request may well be somebody else's, and a page that writes to every pull
 * request it is opened on is a page that edits work by being looked at.
 *
 * Not optimistic, for `useRequeue`'s reason. Whether the policy went green is
 * Azure DevOps' answer and it does not arrive with the write, so the page waits
 * {@link SETTLE_MS} and re-reads rather than drawing a verdict nobody gave.
 */
export function useSquashStrategy(ref: PullRequestRef): SquashStrategy {
  const client = useQueryClient()

  const mutation = useMutation({
    mutationFn: async () => {
      const result = await setSquashStrategy({ data: ref })
      // The server function answers a refusal rather than throwing one;
      // react-query only calls something a failure if it rejects.
      if (!result.ok) throw new Error(result.error ?? 'Azure DevOps did not say why.')

      await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))
    },
    // On failure too: a write whose response was lost may still have landed
    // (`ado-client.ts` note 2), and only the re-read knows.
    onSettled: () => client.invalidateQueries({ queryKey: pullRequestKey(ref) }),
  })

  return {
    ask: () => mutation.mutate(),
    isPending: mutation.isPending,
    error: mutation.error === null ? null : mutation.error.message,
  }
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
