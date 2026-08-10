import {
  Alert02Icon,
  Cancel01Icon,
  Clock01Icon,
  Copy01Icon,
  HelpCircleIcon,
  MinusSignIcon,
  PencilEdit02Icon,
  RefreshIcon,
  Tick02Icon,
  UserCheck01Icon,
  UserMultipleIcon,
  UserRemove01Icon,
} from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useEffect, useMemo, useState } from 'react'
import { TextArea, TextField } from 'react-aria-components'

import type { IconSvgElement } from '@hugeicons/react'
import type { KeyboardEvent, ReactNode } from 'react'

import { age } from './pr-list'
import { Avatar } from './avatar'
import { Markdown } from './markdown'
import { ReviewerPicker } from './reviewer-picker'
import { ChecksPanel } from './checks/panel'
import { Composer } from './comments/composer'
import { ThreadCard } from './comments/thread-card'
import { ChangedFileDiff } from './diff/changed-file'
import { FileTree } from './diff/file-tree'
import { FindBar } from './diff/find-bar'
import { LayoutToggle } from './diff/layout-toggle'
import { ReviewKeys } from './diff/review-keys'
import { WhitespaceToggle } from './diff/whitespace-toggle'
import { SonarPanel, scrollToFinding } from './sonar/panel'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { adoDiffSource, useWarmDiff } from '@/lib/blob-query'
import { COMBINED, lastReview, useChanges, viewRange } from '@/lib/changes'
import { useConversation } from '@/lib/conversation'
import { buildFileTree, treeFiles } from '@/lib/file-tree'
import { lifecycleAction, useAbandon, useReactivate } from '@/lib/lifecycle'
import { readLineTarget } from '@/lib/line-link'
import { commitMessage, defaultDraft, useSquashMerge } from '@/lib/merge'
import { voteWord } from '@/lib/people'
import { useRename } from '@/lib/rename'
import { useRequeue } from '@/lib/requeue'
import { useWithdrawReviewer, withdrawBlocker } from '@/lib/reviewers'
import { useSonarResolve } from '@/lib/sonar-resolve'
import { cn } from '@/lib/utils'
import { useViewedFiles } from '@/lib/viewed'
import { fileViewedKey } from '@/lib/viewed-key'
import { useVote, viewerVote, voteBlocker } from '@/lib/vote'

import type { ThreadActions } from './comments/thread-actions'
import type { SonarJump } from './sonar/panel'
import type { ChangeView } from '@/lib/changes'
import type { FileThreads, IterationContext, Thread } from '@/lib/comment-contract'
import type { Conversation } from '@/lib/conversation'
import type { DiffLayout } from '@/lib/diff-contract'
import type { Withdraw } from '@/lib/reviewers'
import type { SonarFinding } from '@/lib/sonar-contract'
import type { SonarReportResult } from '@/server/sonar-fn'
import type {
  ChangeSet,
  ChangedFile,
  Commit,
  Iteration,
  MergeState,
  Policy,
  PolicyStatus,
  PullRequestDetail,
  PullRequestRef,
  Reviewer,
  Vote,
} from '@/server/pull-request'

// The detail page's reading surface. Split out of the route for the same reason
// the inbox list is: the route's only other job is fetching, and the answer to
// "what is stopping this from merging" is worth being able to test without a
// router or a credential.

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
function branch(ref: string): string {
  return ref.replace(/^refs\/heads\//, '')
}

/**
 * The little words that qualify a row — "draft", "team", "you", "+ body".
 *
 * `.annotation` rather than a hand-rolled `text-[10px] uppercase`: these are the
 * same kind of mark as a section label, so they should be the same type. The
 * 1.5px stroke is Prof's pen weight, in the faint construction ink — a chip that
 * qualifies a row must not outdraw the row.
 *
 * `tone` exists for exactly one caller. "Team", "you" and "+ body" describe the
 * row; "draft" changes what the pull request *is* — it cannot merge — and that
 * is what Prof's amber pen means. Everything else stays in construction ink,
 * because a page where five kinds of chip are five colours has no colour left.
 */
function Chip({ children, tone }: { children: ReactNode; tone?: 'amber' }) {
  return (
    <span
      className={cn(
        'annotation ml-1.5 rounded-sm border-[1.5px] px-1',
        // The pen and the wash carry "draft"; the word itself stays in ink.
        // `--pen-amber` is #b07c1f, which measures 3.09:1 on its own tint — fine
        // for a 1.5px stroke, which only owes 3:1 as a non-text mark, and not
        // fine for the type inside it. Ink on the amber wash is 7.2:1 and the
        // chip still reads as the one amber thing on the row.
        tone === 'amber' ? 'border-pen-amber bg-pen-amber-tint text-ink' : 'border-ink-150',
      )}
    >
      {children}
    </span>
  )
}

/**
 * The header's `<h1>`, and — while the pull request is still open — the one thing
 * on this page that changes the pull request itself.
 *
 * `onRename` being absent is how "not offered" is said, exactly as
 * `threadActions` says it on the diff: an affordance that can only fail is worse
 * than no affordance.
 *
 * **The heading is never the text you typed.** It renders `title`, which is what
 * the page last read out of Azure DevOps, so a rename ADO refused leaves the
 * header saying what ADO still holds — with your words still in the field and the
 * reason underneath it. That is `Composer`'s rule and it is here for the same
 * reason: losing a sentence you wrote to somebody else's 403 is the worst outcome
 * this control has available.
 */
function EditableTitle({
  title,
  onRename,
}: {
  title: string
  /** Resolves and the field closes; rejects and it keeps every character. */
  onRename?: (title: string) => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(title)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Trimmed for both decisions below, because a title is one line of display text
  // and the spaces around it are not part of it — the server trims too, and the
  // no-op check has to compare the thing that would be *stored*.
  const next = text.trim()

  async function save() {
    if (busy || onRename === undefined) return
    // Refused here rather than sent. `renamedTitle` on the server refuses it as
    // well, but a round trip to be told what the field already knows is a round
    // trip that can fail for some entirely unrelated reason and leave a confusing
    // sentence under an empty box.
    if (next === '') return
    // A rename to the title it already has is not a write. ADO takes it happily
    // and adds an update to the pull request saying nothing changed, which is
    // precisely the noise that makes a PR's history unreadable.
    if (next === title) {
      setEditing(false)
      return
    }

    setBusy(true)
    setError(null)
    try {
      await onRename(next)
      setEditing(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Azure DevOps did not take that title.')
    } finally {
      setBusy(false)
    }
  }

  // Bound to the field rather than routed through the command registry, for the
  // reason spelled out on `Composer.onKeyDown`: the app's one keydown listener
  // returns early on `isTextEntry(event.target)`, so neither key can reach it.
  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault()
      void save()
      return
    }
    if (event.key === 'Escape') {
      // Stopped as well as prevented: `nav.back` is Escape at the shell, and
      // abandoning a rename must not also leave the page.
      event.preventDefault()
      event.stopPropagation()
      setEditing(false)
    }
  }

  if (!editing) {
    return (
      // Shrinking rather than growing, so `justify-between` on the row above keeps
      // the ADO link where it has always been, and `min-w-0` so a long title wraps
      // instead of shouldering it off the card.
      <div className="flex min-w-0 items-baseline gap-2">
        <h1 className="min-w-0 text-xl leading-tight font-semibold tracking-tight">{title}</h1>
        {onRename === undefined ? null : (
          // A pencil rather than the word, because the word competes with the title
          // for the same glance: this is the heading's own affordance, and the icon
          // reads as belonging to it where a second piece of text reads as part of
          // it. A `<button>` because it does something rather than going somewhere,
          // and a `<Button>` here would outdraw the title it edits.
          //
          // An icon has no text to speak, so the whole meaning is in the name, and
          // it says what is being renamed — "rename" on its own, in a list of this
          // page's controls, could be about any of them. `title` gives the sighted
          // reader the same sentence on hover.
          <button
            type="button"
            onClick={() => {
              // Reopened against ADO's title, not against whatever was typed the
              // last time this was open and abandoned.
              setText(title)
              setError(null)
              setEditing(true)
            }}
            aria-label="Rename this pull request"
            title="Rename this pull request"
            className="text-muted-foreground hover:text-primary shrink-0"
          >
            {/* 14px against a 20px heading: legible at a glance, and small enough
                that the eye still lands on the title first. */}
            <HugeiconsIcon icon={PencilEdit02Icon} size={14} aria-hidden />
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <div className="flex items-center gap-2">
        {/* The field is not `text-xl`: at the heading's size it would be a 36px box
            where a 25px line was, and the whole card below it would step down as
            you started typing. A rename is a moment, and the moment should not
            move the page. */}
        <TextField
          aria-label="Pull request title"
          value={text}
          onChange={setText}
          className="min-w-0 flex-1"
        >
          {/* Focused on open, because the affordance was pressed to type into it.
              Left enabled while the write is out, as `Composer`'s textarea is:
              disabling it would take focus off the thing you are still looking at. */}
          <Input autoFocus onKeyDown={onKeyDown} />
        </TextField>
        <Button size="xs" onPress={() => void save()} isDisabled={next === '' || busy}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
        <Button variant="ghost" size="xs" onPress={() => setEditing(false)} isDisabled={busy}>
          Cancel
        </Button>
      </div>

      {error === null ? null : (
        // Under the field it belongs to, and at the meta line's size rather than
        // the checklist's 11px: this is a sentence Azure DevOps wrote and nobody
        // can predict, so it has to be readable rather than merely present.
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}
    </div>
  )
}

/** Long enough to be seen, short enough that the line goes back to being a line. */
const COPIED_FOR = 2000

/**
 * Puts the source branch on the clipboard, because the only reason to read a
 * branch name off this page is to type it into a terminal.
 *
 * Three states on one control, drawn as three icons — a page whose meta line is
 * already five identifiers deep does not need a sixth word in it. An icon says
 * nothing out loud, so the accessible name carries the whole meaning, including
 * the branch: "copy" beside two branch names does not say which one it takes.
 */
function CopyBranch({ sourceBranch }: { sourceBranch: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')

  // One sentence for both audiences: the accessible name for anyone listening,
  // and the tooltip for anyone who has to guess what a 14px glyph does.
  const label =
    state === 'copied'
      ? `Copied source branch ${sourceBranch}`
      : state === 'failed'
        ? `Failed to copy source branch ${sourceBranch}`
        : `Copy source branch ${sourceBranch}`

  useEffect(() => {
    if (state === 'idle') return

    const timer = setTimeout(() => setState('idle'), COPIED_FOR)

    return () => clearTimeout(timer)
  }, [state])

  async function copy() {
    // Typed as always there by lib.dom and absent in fact: the Clipboard API is
    // gated on a secure context, so a plain-http LAN address — how somebody
    // running this on another machine reaches it — has no `navigator.clipboard`
    // at all. jsdom has none either, which makes this the path the tests get
    // without arranging anything.
    const clipboard: Clipboard | undefined = navigator.clipboard
    if (clipboard === undefined) {
      setState('failed')
      return
    }

    try {
      await clipboard.writeText(sourceBranch)
      setState('copied')
    } catch {
      // Permission refused, or a document the browser does not consider focused.
      // Caught rather than allowed out, because this is a convenience on a meta
      // line: an unhandled rejection would leave a red console and a control that
      // silently did nothing.
      setState('failed')
    }
  }

  return (
    <button
      type="button"
      onClick={() => void copy()}
      aria-label={label}
      title={label}
      // The visible half of the state, for a test that would otherwise have to
      // assert on which SVG is in the DOM. The name changing is not enough on its
      // own: a control that only acknowledges to a screen reader has not
      // acknowledged.
      data-state={state}
      className={cn(
        // Three icons of one size, so the acknowledgement cannot shove the draft
        // chip sideways and back again the way three words of different lengths
        // would have. `align-[-0.2em]` sits a 14px glyph on the 12px line's
        // baseline instead of hanging it off the top, and it is a replaced element
        // in a `<p>`, so the meta line stays exactly as tall as it was.
        'inline-block align-[-0.2em]',
        state === 'idle' && 'text-muted-foreground hover:text-primary',
        // Teal for the acknowledgement and the pen for the refusal, which is the
        // page's existing pair for "done" and "that did not work".
        state === 'copied' && 'text-primary',
        state === 'failed' && 'text-destructive',
      )}
    >
      <HugeiconsIcon
        icon={state === 'copied' ? Tick02Icon : state === 'failed' ? Cancel01Icon : Copy01Icon}
        size={14}
        aria-hidden
      />
    </button>
  )
}

function Section({
  title,
  count,
  children,
}: {
  title: string
  /** Omitted when the section failed: "0" would be a number we do not have. */
  count?: number
  children: ReactNode
}) {
  return (
    <section className="w-full" aria-label={title}>
      {/* `.annotation` carries the whole style — tiny mono, 0.08em tracking,
          uppercase, secondary ink — so the utilities that used to approximate it
          are gone rather than layered on top of it. The count inherits the mono
          from the same shorthand.
          `text-ink` is the one thing added back: the policy groups inside this
          section are annotations too, and without a pen on the outer label the
          two levels are the same mark. */}
      <h2
        aria-label={count === undefined ? undefined : `${title}, ${count}`}
        className="annotation text-ink mb-1.5 flex items-baseline gap-2"
      >
        {title}
        {count === undefined ? null : <span className="tabular-nums">{count}</span>}
      </h2>
      {children}
    </section>
  )
}

/** "There are none" and "we could not find out" are different facts. */
function Empty({ children }: { children: ReactNode }) {
  return <p className="text-muted-foreground px-2 py-1.5 text-sm">{children}</p>
}

function Failed({ children }: { children: ReactNode }) {
  return (
    <p className="text-destructive flex items-center gap-1.5 px-2 py-1.5 text-sm">
      <HugeiconsIcon icon={Alert02Icon} size={14} className="shrink-0" aria-hidden />
      {children}
    </p>
  )
}

/**
 * ADO's words for "nobody has attempted this merge yet". Neither was seen once
 * in 21,133 live PRs, and an empty `status` — ADO having omitted the field — is
 * deliberately not in here: not saying is not the same as saying "not tested".
 */
const UNTESTED = new Set(['queued', 'notSet'])

function MergeBanner({ merge, conflictsError }: { merge: MergeState; conflictsError: string | null }) {
  // Loud for a real conflict and quiet for everything else. The banner keys on
  // `conflicted`, never on the status: `mergeStatus` arrives empty when ADO
  // omitted it, which it does on every abandoned PR, and an empty or
  // unrecognised status has to read as neutral. A banner that shouts at an
  // untested PR is a banner people stop reading on the conflicted one.
  if (merge.conflicted) {
    return (
      <Alert variant="destructive">
        <HugeiconsIcon icon={Alert02Icon} aria-hidden />
        <AlertTitle>Merge conflicts</AlertTitle>
        <AlertDescription>
          {/* Three states, not two. "It conflicts, and we could not read which
              files" is a worse answer than the path list but a much better one
              than a path list that is silently empty. */}
          {conflictsError !== null ? (
            `This branch conflicts with its target. Azure DevOps did not say which files: ${conflictsError}`
          ) : merge.conflicts.length === 0 ? (
            'This branch conflicts with its target and cannot merge until the conflicts are resolved.'
          ) : (
            // The paths, not the word: they are what says whether this is a
            // five-second rebase or an afternoon.
            <ul aria-label="Conflicting files" className="flex flex-col gap-0.5 font-mono text-xs">
              {merge.conflicts.map((conflict) => (
                <li key={conflict.path}>
                  {conflict.path}
                  {/* ADO's own word, kept verbatim: which side of `deleteEdit`
                      did the deleting is not something the probe established,
                      and a confidently wrong sentence is worse than a token. */}
                  <span className="text-muted-foreground"> {conflict.type}</span>
                  {conflict.resolved ? <Chip>resolved</Chip> : null}
                </li>
              ))}
            </ul>
          )}
        </AlertDescription>
      </Alert>
    )
  }

  if (UNTESTED.has(merge.status)) {
    return (
      <p className="text-muted-foreground text-sm">Azure DevOps has not tested this merge yet.</p>
    )
  }

  return null
}

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
 * Why this pull request cannot be squash-merged from this page, or `null` when it
 * can be.
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
 * The squash-merge section: the commit message that will be written, and the
 * confirmation in front of writing it.
 *
 * Under the policy checklist rather than up in the header, because it is the
 * answer to what the checklist just asked — and because the header is a place
 * the eye passes over on the way to the diff, which is the wrong place for the
 * one control on this page that changes a branch.
 *
 * **The fields are on the page, not in the dialog.** The dialog is dismissable
 * by Escape and by a click outside, which is right for a confirmation and wrong
 * for a paragraph somebody just typed — `Composer`'s "the text survives a failed
 * submit" rule is the same rule seen from the other side. So the message is
 * composed out here, where nothing throws it away, and the dialog *quotes* it: a
 * confirmation that showed a different message from the one being committed
 * would be worse than one that showed none.
 *
 * They are also only drawn when the merge is actually available. An editable
 * commit message on a completed or abandoned pull request offers to do something
 * that cannot be done; blocked, this is what it always was — a disabled button
 * and the sentence saying why.
 *
 * The draft is initialised once and then owned here. React Query re-reads this
 * pull request on every write and after a refused merge, and that hands down a
 * new `pr` without remounting, so a typed message survives the refusal that made
 * the reviewer want to reword it.
 *
 * The confirmation is not a formality: completing a pull request is irreversible,
 * it deletes the source branch, and everybody watching the repository sees it. So
 * it names the pull request, both branches, the message, and what squashing does
 * to the history, and it is reached by pressing a button — there is deliberately
 * no keyboard shortcut anywhere near this, because no single keypress should be
 * able to merge anything.
 */
function MergeControl({
  pr,
  prRef,
  failed,
}: {
  pr: PullRequestDetail
  prRef: PullRequestRef
  failed: FailedSections
}) {
  const [confirming, setConfirming] = useState(false)
  const [draft, setDraft] = useState(() => defaultDraft(pr))
  // Closing on success only, which is what the hook's callback is for: a refused
  // merge has to leave the dialog standing, because ADO's refusal is the whole
  // reason the reviewer pressed the button and it is written right there.
  const merge = useSquashMerge(prRef, () => setConfirming(false))

  const blocker = mergeBlocker(pr, failed)
  const sha = pr.lastMergeSourceCommit
  const message = commitMessage(draft)

  // Kept out of `mergeBlocker`, which answers a question about the pull request's
  // state and is tested without a field in sight. This one is about what is in
  // the box. Keyed on the subject rather than on the whole message, because a
  // body with no subject line composes to a commit whose first line is somebody's
  // second thought.
  const unwritten =
    draft.subject.trim() === '' ? 'A commit needs a message. Write its first line above.' : null

  // One sentence at a time, and the page's own reason first: while a merge is
  // blocked there is nothing to say about the message.
  const refusal = blocker ?? unwritten

  return (
    <div className="sketch-box flex w-full flex-col items-start gap-3 px-4 py-3">
      {blocker === null ? (
        <>
          {/* Subject and body as two fields, because they are two different
              things — the first line is what every shortlog and every ADO commit
              list shows, and a single textarea would let it silently become two
              lines. `lib/merge.ts` puts the blank line between them. */}
          <TextField
            className="flex w-full flex-col gap-1.5"
            value={draft.subject}
            onChange={(subject) => setDraft((was) => ({ ...was, subject }))}
          >
            <Label>Merge commit message</Label>
            <Input />
          </TextField>

          <TextField
            className="flex w-full flex-col gap-1.5"
            value={draft.body}
            onChange={(body) => setDraft((was) => ({ ...was, body }))}
          >
            <Label>Description</Label>
            {/* `Input`'s chrome — the same 1.5px pen on the same input sheet —
                grown downward. `field-sizing-content` with a floor and a manual
                resize handle, like `Composer`'s: a description this page copied
                out of the pull request can be four lines or forty. */}
            <TextArea
              rows={4}
              className="field-sizing-content min-h-20 w-full resize-y rounded-sm border-[1.5px] border-input bg-popover px-2.5 py-1.5 text-base outline-none md:text-sm"
            />
          </TextField>
        </>
      ) : null}

      <Button
        isDisabled={refusal !== null}
        // The reason is a sentence on the page, and it is also this button's
        // description — a disabled control whose explanation is only visual is
        // still a control that will not say why.
        aria-describedby={refusal === null ? undefined : 'merge-blocked'}
        onPress={() => setConfirming(true)}
      >
        Squash and merge
      </Button>
      {refusal === null ? null : (
        <p id="merge-blocked" className="text-muted-foreground text-xs">
          {refusal}
        </p>
      )}

      <Dialog
        isOpen={confirming}
        onOpenChange={(open) => {
          setConfirming(open)
          // So reopening does not still show the last attempt's refusal.
          if (!open) merge.dismiss()
        }}
        // Escape and a click outside are the cancel path, and they stay open
        // exactly while a write is in flight — dismissing then would hide the
        // outcome of something that has already been sent.
        isDismissable={!merge.isPending}
        showCloseButton={false}
      >
        <DialogHeader>
          <DialogTitle>Squash and merge?</DialogTitle>
          <DialogDescription className="flex flex-col gap-2">
            {/* Named, not "this pull request": a confirmation that does not say
                what it is about is a confirmation people click through. */}
            <p>
              <span className="font-mono tabular-nums">!{pr.id}</span> {pr.title}
            </p>
            <p>
              Every commit on <span className="font-mono">{branch(pr.sourceBranch)}</span> becomes
              one commit on <span className="font-mono">{branch(pr.targetBranch)}</span>. Completing
              a pull request cannot be undone.
            </p>
            {/* Quoted verbatim, and scrollable rather than clipped, because this
                is the last place the message can be read before it is permanent
                and a truncated quote is not a quote. Monospaced and
                `whitespace-pre-wrap`: the blank line between subject and body is
                the structure, so it is shown rather than collapsed. */}
            <span className="annotation text-ink">Commit message</span>
            <pre className="sketch-box sketch-box--quiet max-h-40 overflow-y-auto px-2 py-1.5 font-mono text-xs whitespace-pre-wrap">
              {message}
            </pre>
            {/* Both stated because both are things a reviewer would otherwise
                have to take on trust from a button labelled "merge" — and the
                deletion is the half that is easy to be surprised by, so it says
                where the commits went and that the branch can be brought back.
                Azure DevOps offers Restore branch on a completed pull request;
                claiming otherwise here would be scarier than the truth. */}
            <p>
              <span className="font-mono">{branch(pr.sourceBranch)}</span> is deleted — its work
              lives on in the squashed commit, and Azure DevOps can restore the branch afterwards.
              No policy is bypassed.
            </p>
          </DialogDescription>
        </DialogHeader>

        {merge.error === null ? null : (
          // ADO's own words. A refusal here names the policy, or says the source
          // branch has moved, and no sentence of ours could carry that.
          <p role="alert" className="text-destructive text-sm">
            Azure DevOps did not merge it: {merge.error}
          </p>
        )}

        <DialogFooter>
          {/* Cancel first in the DOM, so the dialog opens with focus on the way
              out rather than on the irreversible half. */}
          <DialogClose isDisabled={merge.isPending}>Cancel</DialogClose>
          <Button
            isDisabled={merge.isPending || sha === null}
            onPress={() => {
              // Narrowing, not defence: `mergeBlocker` refuses a null tip, so
              // the dialog cannot be open without one.
              if (sha !== null) merge.run({ lastMergeSourceCommit: sha, commitMessage: message })
            }}
          >
            {merge.isPending ? 'Merging…' : 'Squash and merge'}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  )
}

const POLICY_WORDS: Record<PolicyStatus, string> = {
  approved: 'passed',
  rejected: 'failed',
  // The live probe's finding: on a reviewer policy `queued` means "not yet
  // satisfied", not "something is running". Only a build is actually running.
  queued: 'not yet met',
  running: 'running',
  broken: 'broken',
  notApplicable: 'not applicable',
  unknown: 'unknown',
}

// One pen per verdict, and the glyph is the only place the colour appears — the
// row itself stays ink on paper. A checklist where every row is tinted is a
// checklist with no emphasis left for the one row that is failing.
//
// Amber for both `queued` and `running` even though they mean different things
// ("not yet satisfied" vs "a build is going"): the word beside the icon already
// separates them, and inventing a fourth pen to say so would put a colour in
// this system that nothing else uses.
// Five marks at one size, so the switch below says only which mark and which pen.
function Glyph({ icon, className }: { icon: IconSvgElement; className: string }) {
  return <HugeiconsIcon icon={icon} size={14} className={cn('shrink-0', className)} aria-hidden />
}

/** The pen, apart from the mark, so a row can keep one and change the other. */
function pen(status: PolicyStatus): string {
  switch (status) {
    case 'approved':
      return 'text-pen-green'
    case 'rejected':
    case 'broken':
      return 'text-destructive'
    case 'queued':
    case 'running':
      return 'text-pen-amber'
    case 'notApplicable':
      return 'text-ink-300'
    default:
      return 'text-muted-foreground'
  }
}

function verdictMark(status: PolicyStatus): IconSvgElement {
  switch (status) {
    case 'approved':
      return Tick02Icon
    case 'rejected':
    case 'broken':
      return Cancel01Icon
    case 'queued':
    case 'running':
      return Clock01Icon
    case 'notApplicable':
      return MinusSignIcon
    default:
      return HelpCircleIcon
  }
}

/**
 * The mark on a policy row: what the row waits on, or its verdict.
 *
 * A reviewer policy draws a face instead of a verdict mark, because the two
 * kinds of blocker are not equally interesting. "A build has not finished" is a
 * thing that resolves itself. "Nobody has looked at this yet" is a thing you must
 * go and ask a person for, and finding those rows must not need reading four
 * policy names.
 *
 * The verdict survives the swap: the pen, the group heading, and the word at the
 * end of the row all still carry it. Inside a group every row holds the same
 * verdict anyway, so there the mark was saying the heading over again.
 */
function PolicyIcon({ policy }: { policy: Policy }) {
  const icon = policy.waitsOnPeople ? UserCheck01Icon : verdictMark(policy.status)

  return <Glyph icon={icon} className={pen(policy.status)} />
}

/**
 * The four verdicts, in the order they are read: what is stopping the merge,
 * what is done, what does not apply to this branch, and what is only advice.
 * A policy lands in the first group that claims it.
 */
const GROUPS: ReadonlyArray<[string, (policy: Policy) => boolean]> = [
  ['Blocking', (policy) => policy.blocking],
  ['Passed', (policy) => policy.status === 'approved'],
  ['Not applicable', (policy) => policy.status === 'notApplicable'],
  ['Optional', () => true],
]

function label(policy: Policy): string {
  return policy.detail === null ? policy.name : `${policy.name} — ${policy.detail}`
}

/** One row's share of `useRequeue`, or `null` when the row is not one to requeue. */
interface RowRequeue {
  readonly ask: () => void
  readonly pending: boolean
  /** What ADO said about the last attempt on *this* row, or `null`. */
  readonly error: string | null
}

function PolicyRow({
  policy,
  ambiguous,
  requeue,
}: {
  policy: Policy
  ambiguous: boolean
  requeue: RowRequeue | null
}) {
  return (
    // `border-border` at full strength rather than the old `/60`: `--border` is
    // already Prof's soft line, so the opacity was thinning a line that had
    // been chosen to be quiet. A divider between neighbours in the same panel is
    // exactly what that token is for.
    //
    // The baseline row moved inside, so a failed requeue has a line to be said
    // on. It is drawn under the row it belongs to rather than beside the verdict,
    // because an ADO error is a sentence and the verdict column is four words
    // wide.
    <li className="border-border border-b px-2 py-1 text-sm last:border-b-0">
      <div className="flex items-baseline gap-2">
        <PolicyIcon policy={policy} />
        <span className="min-w-0 flex-1">
          {policy.name}
          {policy.detail === null ? null : (
            <span className="text-muted-foreground"> — {policy.detail}</span>
          )}
          {ambiguous ? (
            <span className="text-muted-foreground font-mono text-2xs"> #{policy.id}</span>
          ) : null}
        </span>
        {policy.url === null ? null : (
          // 1.5px of pen at a 3px offset, and it finds the brand navy on hover.
          // The stock `underline-offset-4` sat a hair too low under 11px type.
          <a
            href={policy.url}
            target="_blank"
            rel="noreferrer"
            className="text-muted-foreground hover:text-primary shrink-0 text-2xs underline decoration-[1.5px] underline-offset-[3px]"
          >
            result
          </a>
        )}
        {requeue === null ? null : (
          // Drawn as the link beside it and not as a `<Button>`: this sits in a
          // row of eleven-pixel type, and a real button here would outweigh the
          // verdict it is about. It is still a `<button>`, because it does
          // something rather than going somewhere.
          //
          // The name carries the policy so a checklist with three build rows has
          // three distinguishable controls — "requeue" three times over is a
          // screen reader listing the same action thrice.
          <button
            type="button"
            onClick={requeue.ask}
            disabled={requeue.pending}
            aria-label={`Requeue ${label(policy)}`}
            className="text-muted-foreground hover:text-primary shrink-0 text-2xs underline decoration-[1.5px] underline-offset-[3px] disabled:no-underline disabled:opacity-60"
          >
            {requeue.pending ? 'requeuing…' : 'requeue'}
          </button>
        )}
        {/* Mono, because this column is read down rather than across: the verdicts
            line up on a shared advance width and a row that says "failed" jumps
            out of a stack of "passed". Wider than the old `w-24` to hold "not
            applicable" at mono's advance. */}
        <span className="text-muted-foreground w-28 shrink-0 text-right font-mono text-2xs">
          {POLICY_WORDS[policy.status]}
        </span>
      </div>
      {requeue === null || requeue.error === null ? null : (
        // Indented to the text it belongs under, past the verdict glyph.
        <p className="text-destructive ml-[1.375rem] text-2xs">
          Azure DevOps did not requeue it: {requeue.error}
        </p>
      )}
    </li>
  )
}

function PolicyChecklist({
  policies,
  prRef,
}: {
  policies: readonly Policy[]
  prRef: PullRequestRef
}) {
  // One mutation for the whole checklist rather than one per row: only one
  // requeue is ever in flight — the button that started it is disabled — and a
  // hook per row would mean a `useMutation` per policy on every render.
  const requeue = useRequeue(prRef)

  const buckets = GROUPS.map(() => [] as Policy[])
  for (const policy of policies) {
    buckets[GROUPS.findIndex(([, matches]) => matches(policy))].push(policy)
  }

  // `configuration.type.displayName` is not unique — the probe found two
  // "Minimum number of reviewers" on one PR — and the settings do not always
  // offer a qualifier. A row that still collides after its detail carries the
  // configuration id, because two identical rows with different verdicts are a
  // checklist nobody can act on.
  const counts = new Map<string, number>()
  for (const policy of policies) counts.set(label(policy), (counts.get(label(policy)) ?? 0) + 1)

  return (
    <div className="flex w-full flex-col gap-3">
      {GROUPS.map(([name], index) =>
        buckets[index].length === 0 ? null : (
          <div key={name}>
            {/* A group heading is the same kind of mark as the section heading
                above it, one level quieter — so it is the same `.annotation`,
                and the only thing that distinguishes "Blocking" is the red pen.
                That override sits in `@layer utilities`, above `.annotation`'s
                own colour, so it wins without `!`. */}
            <h3 className={cn('annotation mb-1', name === 'Blocking' && 'text-destructive')}>
              {name}
            </h3>
            {/* Quiet, because four of these can stack under one heading and a
                drawn outline with a shadow on each would read as four cards
                rather than four groups of one list. */}
            <ul aria-label={name} className="sketch-box sketch-box--quiet">
              {buckets[index].map((policy) => (
                <PolicyRow
                  key={policy.id}
                  policy={policy}
                  ambiguous={(counts.get(label(policy)) ?? 0) > 1}
                  requeue={
                    policy.requeueId === null
                      ? null
                      : {
                          ask: () => requeue.ask(policy),
                          pending: requeue.pendingId === policy.id,
                          error:
                            requeue.failure?.id === policy.id ? requeue.failure.message : null,
                        }
                  }
                />
              ))}
            </ul>
          </div>
        ),
      )}
    </div>
  )
}

/**
 * Which pen each vote is drawn in.
 *
 * Both approvals are teal because this column answers one question — does this
 * reviewer stand between the branch and the target — and "approved with
 * suggestions" does not. The words already tell them apart; a second pen for the
 * caveat would spend a colour saying what the sentence says.
 *
 * "No vote" gets the bare badge: card paper, ink outline, and the dot's default
 * grey. It is the state most reviewers are in on most pull requests, and it is
 * the one that must not draw the eye. An unrecognised integer falls to navy,
 * because a vote scale that grew a sixth value is worth looking at.
 */
const VOTE_TONES = new Map<number, string>([
  [10, 'prof-badge--teal'],
  [5, 'prof-badge--teal'],
  [0, ''],
  [-5, 'prof-badge--amber'],
  [-10, 'prof-badge--red'],
])

/**
 * The same five, as things to do rather than states to be in.
 *
 * Imperative labels against `VOTES`' past tense — "Approve" on the button,
 * "approved" on the badge — because the two are read differently. One is an offer
 * and the other is a fact, and a row of five buttons all reading like statuses is
 * a row nobody can tell they are allowed to press. "No vote" keeps ADO's own
 * phrase rather than "Reset" or "Clear": the value it writes is `0`, which is a
 * position on the scale and not the absence of one.
 *
 * In ADO's own order, most positive first, so the row reads yes to no with the
 * neutral in the middle. Every one carries an icon *and* a word — the badge
 * beside them is the only coloured thing here, and colour is never the only
 * channel telling two of these apart.
 */
const VOTE_CHOICES: ReadonlyArray<{ vote: Vote; label: string; icon: IconSvgElement }> = [
  { vote: 10, label: 'Approve', icon: Tick02Icon },
  { vote: 5, label: 'Approve with suggestions', icon: HelpCircleIcon },
  { vote: 0, label: 'No vote', icon: MinusSignIcon },
  { vote: -5, label: 'Wait for author', icon: Clock01Icon },
  { vote: -10, label: 'Reject', icon: Cancel01Icon },
]

/**
 * Where the viewer stands, and the five ways to change it.
 *
 * In the header, because a vote is a fact about the pull request as a whole and
 * not about any one of the lists below it — and because the reviewers section is a
 * record of what everybody thinks, which is a different thing from a control for
 * what you think.
 *
 * No confirmation on any of the five, deliberately: a vote is correctable by
 * voting again, and the button that corrects it is right there. Contrast
 * `LifecycleControl`, which asks.
 */
function VoteControl({ pr, prRef }: { pr: PullRequestDetail; prRef: PullRequestRef }) {
  const vote = useVote(prRef)

  const blocker = voteBlocker(pr)
  const current = viewerVote(pr)
  const busy = vote.pending !== null

  // The notice the ticket is really about. `approvalReset` is `null` when nobody
  // has hydrated this pull request, and `null` renders as silence rather than as
  // reassurance — see `PullRequestDetail.approvalReset`.
  //
  // Gated on the vote the page last read, and *not* on whether a vote was just
  // sent: pressing Approve does not take this notice down, because until the
  // re-read comes back the honest answer is still "your approval was reset". It
  // goes when ADO says the vote is standing again, which is the only thing that
  // could take it down truthfully.
  const stale = pr.approvalReset === true && (current ?? 0) <= 0

  return (
    <div className="flex min-w-0 flex-col items-start gap-1.5">
      {stale ? (
        <p className="text-destructive flex items-center gap-1 text-xs">
          <HugeiconsIcon icon={RefreshIcon} size={12} aria-hidden />
          A push reset your approval, so it is not standing until you vote again.
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        {/* State first, then the offers, so the row answers "where am I" before
            "what can I do". Absent entirely when we cannot attribute a vote —
            `viewerVote` returns `null` for an unresolved viewer, and a badge
            reading "no vote" would be claiming to know something. */}
        {current === null ? null : (
          <span className={cn('prof-badge', VOTE_TONES.get(current) ?? 'prof-badge--navy')}>
            <span className="prof-badge__dot" aria-hidden />
            {voteWord(current)}
          </span>
        )}

        {/* A group with a name, not five loose buttons: "Approve" on its own does
            not say what it is approving, and the description carries the refusal
            for all five at once. */}
        <div
          role="group"
          aria-label="Your vote"
          aria-describedby={blocker === null ? undefined : 'vote-blocked'}
          className="flex flex-wrap items-center gap-1"
        >
          {VOTE_CHOICES.map((choice) => (
            <Button
              key={choice.vote}
              size="xs"
              // The one that is already the answer is drawn as held down rather
              // than as another thing to press, and `aria-pressed` says so for
              // anybody who is not looking at the fill.
              variant={current === choice.vote ? 'secondary' : 'ghost'}
              aria-pressed={current === choice.vote}
              // All five go quiet while one is in flight. Leaving the other four
              // live would let a reviewer queue two votes on a scale where only
              // the last one survives.
              isDisabled={blocker !== null || busy}
              onPress={() => vote.run(choice.vote)}
            >
              <HugeiconsIcon icon={choice.icon} size={13} aria-hidden />
              {choice.label}
            </Button>
          ))}
        </div>
      </div>

      {blocker === null ? null : (
        <p id="vote-blocked" className="text-muted-foreground text-xs">
          {blocker}
        </p>
      )}
      {/* Which vote, not just that something is happening: with the whole group
          disabled, the label is the only thing left saying what was pressed. */}
      {vote.pending === null ? null : (
        <p role="status" className="annotation">
          setting your vote to {voteWord(vote.pending)}…
        </p>
      )}
      {vote.error === null ? null : (
        // ADO's words. A refusal here is a permissions answer or a "you are not a
        // reviewer", and both belong to it rather than to us.
        <p role="alert" className="text-destructive text-xs">
          Azure DevOps did not record your vote: {vote.error}
        </p>
      )}
    </div>
  )
}

/**
 * Closing this pull request without merging it, or opening it again.
 *
 * One button, because the two verbs are never both available: an abandoned pull
 * request is the only kind you can reactivate. Both stay on the page when they do
 * not apply, disabled with the sentence saying why — the ticket's "refused with a
 * reason rather than hidden", and the same shape `MergeControl` uses.
 *
 * Abandon confirms and reactivate does not, which is the line the ticket draws:
 * abandoning closes work other people are waiting on, and reactivating undoes it
 * exactly. See `useReactivate`.
 */
function LifecycleControl({ pr, prRef }: { pr: PullRequestDetail; prRef: PullRequestRef }) {
  const [confirming, setConfirming] = useState(false)
  // Success only, as in `MergeControl`: a refusal has to leave the dialog up,
  // because ADO's reason is written inside it.
  const abandon = useAbandon(prRef, () => setConfirming(false))
  const reactivate = useReactivate(prRef)

  const { kind, blocker } = lifecycleAction(pr)

  return (
    <div className="flex shrink-0 flex-col items-start gap-1.5">
      <Button
        // Destructive for the one that closes work, plain outline for the one
        // that reopens it. The two never appear together, so the pen is doing
        // the work a pair of buttons side by side would have done.
        variant={kind === 'abandon' ? 'destructive' : 'outline'}
        size="sm"
        isDisabled={blocker !== null || reactivate.isPending}
        aria-describedby={blocker === null ? undefined : 'lifecycle-blocked'}
        onPress={() => {
          if (kind === 'abandon') setConfirming(true)
          else reactivate.run()
        }}
      >
        {kind === 'abandon' ? 'Abandon' : reactivate.isPending ? 'Reactivating…' : 'Reactivate'}
      </Button>
      {blocker === null ? null : (
        <p id="lifecycle-blocked" className="text-muted-foreground text-xs">
          {blocker}
        </p>
      )}
      {reactivate.error === null ? null : (
        <p role="alert" className="text-destructive text-xs">
          Azure DevOps did not reactivate it: {reactivate.error}
        </p>
      )}

      <Dialog
        isOpen={confirming}
        onOpenChange={(open) => {
          setConfirming(open)
          if (!open) abandon.dismiss()
        }}
        isDismissable={!abandon.isPending}
        showCloseButton={false}
      >
        <DialogHeader>
          <DialogTitle>Abandon this pull request?</DialogTitle>
          <DialogDescription className="flex flex-col gap-2">
            <p>
              <span className="font-mono tabular-nums">!{pr.id}</span> {pr.title}
            </p>
            {/* What it does and, just as importantly, what it does not do. The
                word "abandon" sounds like a delete, and a reviewer who thinks it
                is one will not press it when it is the right answer. */}
            <p>
              It closes without merging and drops out of everybody&rsquo;s review queue. The branch,
              the commits, the comments and the votes all stay where they are.
            </p>
            <p>You can reactivate it from this header afterwards.</p>
          </DialogDescription>
        </DialogHeader>

        {abandon.error === null ? null : (
          <p role="alert" className="text-destructive text-sm">
            Azure DevOps did not abandon it: {abandon.error}
          </p>
        )}

        <DialogFooter>
          {/* Cancel first in the DOM, so focus opens on the way out. */}
          <DialogClose isDisabled={abandon.isPending}>Cancel</DialogClose>
          <Button variant="destructive" isDisabled={abandon.isPending} onPress={() => abandon.run()}>
            {abandon.isPending ? 'Abandoning…' : 'Abandon'}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  )
}

/**
 * Taking one person off, from their own row.
 *
 * **`aria-disabled` and not `disabled`**, in the one case where the control is
 * refused for a reason worth reading: a `disabled` button cannot be focused, so
 * the sentence explaining why a voted reviewer cannot be removed here would be
 * unreachable by exactly the reader who has no hover. The click is guarded in the
 * handler instead, which is what `aria-disabled` obliges.
 *
 * A container gets no control at all rather than a refused one. Its blocker is not
 * about anything the reader did — a branch policy put it there — and 127 of the 150
 * reviewers sampled on this org are containers, so a refused button on each of
 * them is a column of grey crosses down the commonest reviewer list there is.
 */
function WithdrawButton({ reviewer, withdraw }: { reviewer: Reviewer; withdraw: Withdraw }) {
  const blocker = withdrawBlocker(reviewer)
  const going = withdraw.pending === reviewer.id

  // The width the button occupies, so the vote column does not step left on the
  // rows that have no button.
  if (reviewer.isContainer) return <span className="w-3.5 shrink-0" aria-hidden />

  const label = going
    ? `Taking ${reviewer.displayName} off this pull request…`
    : (blocker ?? `Take ${reviewer.displayName} off this pull request`)

  return (
    <button
      type="button"
      aria-disabled={blocker !== null || going}
      // The whole meaning is in the name, `TitleField`'s pencil's reason: an icon
      // says nothing, and "remove" on its own in a list of this page's controls
      // could be about any of them. `title` gives the sighted reader the same
      // sentence — including the refusal, which is the only place it is written.
      aria-label={label}
      title={label}
      onClick={() => {
        if (blocker === null && !going) withdraw.run(reviewer.id)
      }}
      className={cn(
        'shrink-0',
        blocker === null && !going
          ? 'text-muted-foreground hover:text-destructive'
          : 'text-ink-300',
      )}
    >
      <HugeiconsIcon icon={UserRemove01Icon} size={14} aria-hidden />
    </button>
  )
}

function ReviewerRow({
  reviewer,
  viewerId,
  withdraw,
}: {
  reviewer: Reviewer
  viewerId: string | null
  /** Absent when nobody can be taken off — a pull request that is no longer active. */
  withdraw?: Withdraw
}) {
  return (
    // `items-center`, where every other row in this file is `items-baseline`:
    // this one holds a blob and a pill rather than three runs of text, and a
    // circle sitting on a text baseline hangs.
    <li className="border-border flex items-center gap-2 border-b px-2 py-1.5 text-sm last:border-b-0">
      {/* A face when ADO gave us a link a browser can actually load, and the
          monogram underneath it otherwise — `Avatar` decides which, because the
          same `imageUrl` field carries two URL shapes and only one of them answers
          without a credential (note 11). A container keeps its glyph: 127 of the
          150 reviewers on this org are groups, and a group has no face to show. */}
      <Avatar
        href={reviewer.avatarHref}
        name={reviewer.displayName}
        className="size-5"
        fallback={
          reviewer.isContainer ? <HugeiconsIcon icon={UserMultipleIcon} size={12} /> : undefined
        }
      />
      <span className="min-w-0 flex-1">
        {reviewer.displayName}
        {reviewer.isContainer ? <Chip>team</Chip> : null}
        {viewerId !== null && reviewer.id === viewerId ? <Chip>you</Chip> : null}
        {reviewer.votedFor.length > 0 ? (
          <span className="text-muted-foreground text-xs">
            {' '}
            on behalf of {reviewer.votedFor.map((team) => team.displayName).join(', ')}
          </span>
        ) : null}
      </span>
      {/* Required carries full weight and optional recedes: `isRequired` sits
          on 127 containers against 23 people in the live sample, so a section
          that reads teams as a footnote reads almost empty on a real PR. In
          Prof that weight is the brand pen against `.annotation`'s secondary
          ink, not a bolder face — the label is 11px mono, and bold at 11px
          thickens into a smudge before it reads as emphasis. */}
      <span className={cn('annotation w-16 shrink-0 text-right', reviewer.isRequired && 'text-ink')}>
        {reviewer.isRequired ? 'required' : 'optional'}
      </span>
      {/* Wide enough for "approved with suggestions" in a pill, which is what
          set this column's width — the badge's own padding and dot cost about
          30px on top of the words. */}
      <span className="flex w-52 shrink-0 justify-end">
        <span className={cn('prof-badge', VOTE_TONES.get(reviewer.vote) ?? 'prof-badge--navy')}>
          <span className="prof-badge__dot" aria-hidden />
          {voteWord(reviewer.vote)}
        </span>
      </span>
      {withdraw === undefined ? null : <WithdrawButton reviewer={reviewer} withdraw={withdraw} />}
    </li>
  )
}

/**
 * Who was asked, and — while the pull request is still open — asking somebody else.
 *
 * A component rather than the section's body so the removal mutation is one hook
 * for the whole list instead of one per row: `withdraw.pending` carries the id, so
 * the row being removed is the row that says so, and a refusal is reported once
 * under the list rather than inside a row that may be gone by then.
 *
 * `canWrite` is the pull request being active, decided at the call site the way
 * `onRename` is. Adding a reviewer to something merged or abandoned is a write ADO
 * may well accept and nobody will ever act on.
 */
function ReviewerList({
  prRef,
  reviewers,
  viewerId,
  canWrite,
}: {
  prRef: PullRequestRef
  reviewers: readonly Reviewer[]
  viewerId: string | null
  canWrite: boolean
}) {
  const withdraw = useWithdrawReviewer(prRef)

  return (
    <>
      {reviewers.length === 0 ? (
        <Empty>Nobody has been asked to review this.</Empty>
      ) : (
        <ul className="sketch-box sketch-box--quiet w-full">
          {reviewers.map((reviewer) => (
            <ReviewerRow
              key={reviewer.id}
              reviewer={reviewer}
              viewerId={viewerId}
              withdraw={canWrite ? withdraw : undefined}
            />
          ))}
        </ul>
      )}

      {withdraw.error === null ? null : (
        <p role="alert" className="text-destructive mt-1.5 flex items-baseline gap-2 text-xs">
          <span>Azure DevOps did not take them off: {withdraw.error}</span>
          <button type="button" className="hover:text-primary underline" onClick={withdraw.dismiss}>
            Dismiss
          </button>
        </p>
      )}

      {canWrite ? <ReviewerPicker prRef={prRef} reviewers={reviewers} /> : null}
    </>
  )
}

function CommitRow({ commit }: { commit: Commit }) {
  return (
    <li className="border-border flex items-baseline gap-2 border-b px-2 py-1 text-sm last:border-b-0">
      {/* Bare mono with no underline until you want it: seven hex characters
          are already visibly a link's worth of "this is an identifier", and
          underlining every sha in a run of thirty draws a ladder down the
          gutter. The brand navy on hover is the affordance. */}
      <a
        href={commit.url}
        target="_blank"
        rel="noreferrer"
        className="text-muted-foreground hover:text-primary w-16 shrink-0 font-mono text-2xs"
      >
        {commit.id.slice(0, 7)}
      </a>
      <span className="min-w-0 flex-1 truncate">
        {commit.subject}
        {/* Not "truncated": the subject is whole, and ADO's own name for this
            flag is a trap the contract now spells out. It says there is a
            message body underneath, which is worth knowing and is not a
            defect — it is true of about half the commits on this org. */}
        {commit.bodyOmitted ? <Chip>+ body</Chip> : null}
      </span>
      <span className="text-muted-foreground hidden shrink-0 truncate text-xs sm:block sm:max-w-40">
        {commit.author}
      </span>
      {/* Mono for the age, like every other figure on the page: "3d" and "12h"
          land on the same two columns down a list of thirty commits, which is
          the only reason this column is worth its width. */}
      <span
        className="text-muted-foreground w-16 shrink-0 text-right font-mono text-2xs tabular-nums"
        title={commit.at}
      >
        {age(commit.at)}
      </span>
    </li>
  )
}

/**
 * How one update reads in the dropdown, and in the heading above the list.
 *
 * The subject and not the author: on a pull request with a run of pushes they are
 * all by the same person, so the author distinguishes nothing while the tip
 * commit's first line says which push this was. The reason rides along only when
 * it is not a plain push — a force push or a rebase changes what the update's
 * diff even means, and all 44 iterations measured said `push`, so seeing anything
 * else there is worth a second look.
 */
function updateLabel(iteration: Iteration): string {
  const parts = [`Update ${iteration.id}`]
  if (iteration.createdAt !== '') parts.push(age(iteration.createdAt))
  if (iteration.reason !== 'push') parts.push(iteration.reason)
  if (iteration.subject !== '') parts.push(iteration.subject)

  return parts.join(' · ')
}

/**
 * Which update the "By update" tab is showing.
 *
 * A dropdown and not tabs of its own: median 2 updates but a p99 of 15 and a real
 * pull request with 39, which is thirty-nine tabs across a page that also has to
 * hold a file tree.
 */
function UpdatePicker({
  iterations,
  selected,
  onSelect,
}: {
  iterations: readonly Iteration[]
  selected: number
  onSelect: (iterationId: number) => void
}) {
  return (
    <select
      aria-label="Update"
      value={selected}
      onChange={(event) => onSelect(Number(event.target.value))}
      // A control's own edge is the strong line in Prof, drawn at the pen's
      // 1.5px, and an input is the brightest sheet on the page — `bg-background`
      // made the one thing on this line you can operate look like the page it
      // sits on. The native `<select>` keeps its own arrow: a hand-drawn
      // chevron would mean rebuilding the popup, and the popup is the part that
      // works on a 39-update pull request.
      className="border-ink bg-paper-3 max-w-full rounded-sm border-[1.5px] px-1.5 py-0.5 text-xs"
    >
      {/* Newest first: the reason to be in this view at all is the push that just
          arrived, and it should not be at the bottom of thirty-nine. */}
      {[...iterations].reverse().map((iteration) => (
        <option key={iteration.id} value={iteration.id}>
          {updateLabel(iteration)}
        </option>
      ))}
    </select>
  )
}

/**
 * A date a sentence can hold: "3 August", and the year too when it was not this one.
 *
 * `age()` is what the rest of the page dates things with and it is wrong here.
 * "Since 4 days ago" stops being true while you read it, and the reader is being
 * told the fixed point a comparison was made against, which is the one thing on
 * this page that must not drift.
 */
function onDate(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return iso

  return at.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    ...(at.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }),
  })
}

/** The four things this page can be showing. */
export type DetailTab = 'details' | 'combined' | 'update' | 'since'

interface TabSpec {
  readonly id: DetailTab
  readonly label: string
  readonly count?: number
}

/**
 * Details, the combined diff, one update, or everything since I last looked.
 *
 * Details leads and is the default because of what this page is for: the answer to
 * "what is stopping this from merging" comes before the diff, not after it. The
 * diff tabs exist so that when you do go to read the code you get the whole window
 * for it — a tree down one side and eighty columns of it — instead of the bottom
 * third of a page whose top is a policy checklist you have already read.
 *
 * "By update" and "Since my review" are both absent on a single-update pull
 * request, nearly half of them measured, because there every view is the same files
 * and offering a choice between them only invites the reader to look for a
 * difference.
 *
 * "Since my review" is offered even when there is nothing to show, because the
 * reasons there is nothing — you never reviewed this, nothing has been pushed since
 * you did — are answers to the question the tab asks, and a tab that is missing or
 * greyed out gives neither.
 */
function TabStrip({
  tab,
  tabs,
  onTabChange,
}: {
  tab: DetailTab
  tabs: readonly TabSpec[]
  onTabChange: (tab: DetailTab) => void
}) {
  return (
    // `.prof-tabs` brings the flex row, the 24px gap and the hairline the strip
    // sits on. The gap is the class's and not a `gap-*` here: Prof separates two
    // tabs by `--space-5` and nothing else, because the ink under the active one
    // is exactly as wide as its label, which is the point of drawing it.
    <div role="tablist" aria-label="Pull request" className="prof-tabs w-full items-baseline">
      {tabs.map(({ id, label, count }) => (
        <button
          key={id}
          type="button"
          role="tab"
          id={`tab-${id}`}
          aria-selected={tab === id}
          aria-controls={`panel-${id}`}
          // One tab stop for the strip, arrows to move inside it. The alternative
          // costs three presses to get past a control that sits above a diff with
          // a checkbox on every file.
          tabIndex={tab === id ? 0 : -1}
          onKeyDown={(event) => {
            const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
            if (step === 0) return

            event.preventDefault()
            const next = tabs[(tabs.findIndex((entry) => entry.id === tab) + step + tabs.length) % tabs.length]
            if (next === undefined) return

            onTabChange(next.id)
            // Focus follows selection, which is the automatic-activation pattern
            // and what makes arrows usable at all: the row we are standing on is
            // about to become `tabIndex={-1}`.
            document.getElementById(`tab-${next.id}`)?.focus()
          }}
          onClick={() => onTabChange(id)}
          // The old `rounded-t` was a directional radius, which the sketch
          // radii cannot survive — they are multi-value, and a multi-value
          // radius in a longhand drops the whole declaration. It went out with
          // the 2px bottom border it was cornering: Prof marks the active tab
          // with a stroke drawn underneath it instead, so the ink below is the
          // mark and there is nothing left to round. `.prof-tab` owns the
          // padding, the type and the hover colour, and no utility here adds to
          // them — a `flex` on a tab makes it a block-level box, which is a
          // vertical stack of labels the moment anything costs the strip its own
          // `display`.
          className={cn('prof-tab', tab === id && 'prof-tab--active')}
        >
          {label}
          {/* `.prof-tab__count` rather than the mono utilities it replaces: the
              count is part of the component in Prof, down to the 6px it sits
              off the label. */}
          {count === undefined ? null : <span className="prof-tab__count">{count}</span>}
          {/* Inside the button so it tracks the label's width, and `aria-hidden`
              because the tab already says which one it is through
              `aria-selected`. */}
          {tab === id ? <TabInk /> : null}
        </button>
      ))}
    </div>
  )
}

/**
 * The stroke under the active tab, drawn rather than shown.
 *
 * A dash paid out along the curve is the whole trick: the round cap is a pen nib
 * travelling left to right and the ink behind it is already the finished stroke.
 * Growing a width or a `scaleX` would stretch the *drawing* instead — the whole
 * line visible from the first frame — which is a rubber band, not a hand.
 *
 * `pathLength={1}` is what lets the stylesheet own the animation, and it is the
 * one attribute here that is load-bearing. It tells the browser to treat the
 * curve as exactly one unit long however many pixels wide the label is, so the
 * dash and its offset are fractions that CSS can write without ever measuring
 * the path. `prof-tab-ink` in `styles.css` slides the offset; there is no
 * per-frame JavaScript, and no hook needed to ask about reduced motion.
 *
 * `preserveAspectRatio` and the explicit `width` in `styles.css` go together:
 * this is a replaced element, so it has to be *told* the label's width or it
 * takes 160px from the viewBox ratio, and it has to be told not to letterbox the
 * curve inside whatever width that is.
 *
 * Rendered only inside the active tab, so switching tabs unmounts it and mounts a
 * new one: the pen lifts and draws again under the new label rather than sliding
 * across the gap, and a fresh element is also what restarts the animation.
 *
 * The `d` and the 160×8 box are `--stroke-underline-teal`'s, so light and dark
 * still meet at the same curve; `--teal-500` is the one thing that differs
 * between them and CSS already answers that.
 */
function TabInk() {
  return (
    <svg
      className="prof-tab__ink"
      viewBox="0 0 160 8"
      // The stroke is set as wide as the label, whatever the label is, and a
      // 5-character tab is not a 22-character one. Prof's own underline is a
      // stretched background image for the same reason.
      preserveAspectRatio="none"
      aria-hidden
    >
      <path
        d="M3 5.5 C 40 3.2, 95 3.0, 157 4.6"
        fill="none"
        pathLength={1}
        // The colour is in `styles.css`, not a `stroke=` here, because a `var()`
        // in an SVG presentation attribute is not resolved by any browser — and
        // an unresolvable `stroke` is `none`, so the first cut of this drew a
        // perfect invisible line. The stylesheet is where `--teal-500` can be
        // read anyway, and it is where the theme rebinds it.
        strokeWidth={2.2}
        strokeLinecap="round"
      />
    </svg>
  )
}

/**
 * Whether this row is one of the marked ones.
 *
 * `fileViewedKey` returns `null` for a change entry with a blob on neither side
 * — nothing a mark could be about, so nothing that can be marked. Folded into
 * `false` here rather than handled, because `loadFiles` filters those out and no
 * live payload has produced one.
 */
function isViewed(viewed: ReadonlySet<string>, file: ChangedFile): boolean {
  const key = fileViewedKey(file)
  return key !== null && viewed.has(key)
}

/**
 * Whether resolved conversations are out of the way.
 *
 * Beside the layout toggle and not inside a file, for the reason `LayoutToggle`
 * is: it is a statement about how you are reading this pass, not about the file
 * in front of you. A row-model input on the way down, so a hidden thread costs
 * no measured row — see `setHideDone`.
 */
function HideDoneToggle({
  hideDone,
  onHideDoneChange,
}: {
  hideDone: boolean
  onHideDoneChange: (hideDone: boolean) => void
}) {
  return (
    <button
      type="button"
      aria-pressed={hideDone}
      onClick={() => onHideDoneChange(!hideDone)}
      // Styled as `LayoutToggle`'s options are, for the reason above: these two
      // controls sit on the same line and answer the same kind of question, so a
      // pressed one should look pressed the same way. That means `rounded-sm`
      // rather than bare `rounded`, which is the one step in the scale still
      // mapped to a machine corner, and the teal wash rather than `bg-muted`,
      // which reads as sunken on a control that has been chosen.
      className={cn(
        'rounded-sm px-1.5 py-0.5',
        hideDone ? 'text-ink bg-accent' : 'hover:text-foreground',
      )}
    >
      Hide resolved
    </button>
  )
}

/**
 * What the file list below is a list *of*, in the three places the reader is told.
 *
 * One object rather than three props because the three sentences have to agree:
 * "Update 4" beside the count and "Loading these changes…" underneath it is a page
 * that has stopped saying which question it is answering.
 */
interface ChangeScope {
  /** The update picker, or the sentence a range states itself by. `null` for the combined diff, which is the page's default and needs no label. */
  readonly control: ReactNode
  /** The middle of "Could not load …" and "Loading …". */
  readonly what: string
  /** What no files means here, which is a different fact in each view. */
  readonly empty: string
}

function ChangedFiles({
  changes,
  scope,
  pending,
  error,
  ref,
  conflicted,
  layout,
  onLayoutChange,
  ignoreWhitespace,
  onIgnoreWhitespaceChange,
  viewed,
  onViewedChange,
  threads,
  threadActions,
  threadError,
  hideDone,
  onHideDoneChange,
  iterationContext,
  jump,
  findings,
  webUrl,
}: {
  /** The selected view's files — the combined diff, one update's, or a range's. */
  changes: ChangeSet
  scope: ChangeScope
  pending: boolean
  error: string | null
  ref: PullRequestRef
  /** Conflict paths match `changeEntries[].item.path` exactly, so the banner's
      files can be found again in the list they actually live in. */
  conflicted: ReadonlySet<string>
  layout: DiffLayout
  onLayoutChange: (layout: DiffLayout) => void
  ignoreWhitespace: boolean
  onIgnoreWhitespaceChange: (ignoreWhitespace: boolean) => void
  viewed: ReadonlySet<string>
  onViewedChange: (file: ChangedFile, viewed: boolean) => void
  /**
   * Anchored threads by path, grouped once by the page rather than once per
   * panel: a 294-file pull request would otherwise walk the thread list 294
   * times to find the handful of files that have comments on them.
   */
  threads: ReadonlyMap<string, FileThreads>
  /** Absent while the conversation cannot be written — nothing here is disabled, it is not offered. */
  threadActions?: ThreadActions
  /**
   * Why there are no comments, when the reason is a failed call rather than an
   * empty conversation. Said quietly and beside the diff rather than instead of
   * it: T-023's whole point is that a failing threads read costs the
   * conversation and nothing else.
   */
  threadError: string | null
  hideDone: boolean
  onHideDoneChange: (hideDone: boolean) => void
  /** Which iterations a thread started on this diff is written against. */
  iterationContext: IterationContext | null
  /**
   * Where a click on the details tab is sending the reader, while it is still
   * being answered. Only the line half is passed on: the file half is the page's
   * own scroll, which has already happened by the time a panel sees this.
   */
  jump: SonarJump | null
  /**
   * Sonar's findings, flattened into the panel's own order, for the keys that
   * step through them. Empty on a pull request Sonar has not analysed.
   *
   * Down here rather than bound beside the panel that lists them, because
   * stepping through findings is something you do while reading the diff — and
   * this is where the jump that answers it already lives.
   */
  findings: readonly SonarFinding[]
  /** The pull request's ADO address, which each line's open-in-ADO link is built from. */
  webUrl: string
}) {
  const nodes = useMemo(() => buildFileTree(changes.files), [changes.files])

  // The tree's order, not the payload's, and one order for both halves. Grouping
  // the list by change type — which is what this replaced — reads well alone and
  // fights a tree beside it: `src/a.ts` and `src/b.ts` end up a screen apart, and
  // then a sidebar row and the panel it points at have nothing to do with each
  // other. The change type survives as the letter on each tree row, and now that
  // files are expanded, as the panel's own add and delete notices.
  const ordered = useMemo(() => treeFiles(nodes), [nodes])

  const read = changes.files.filter((file) => isViewed(viewed, file)).length
  const isRead = (file: ChangedFile) => isViewed(viewed, file)

  const source = adoDiffSource(ref)

  const [term, setTerm] = useState('')

  // A find's own jump, held for exactly as long as the page's own one is: set,
  // acted on, cleared. Separate from `jump` because that belongs to the Sonar
  // panel and is cleared by an effect that only runs on the combined tab, and
  // because clearing is what lets the same match be stepped to twice.
  const [sent, setSent] = useState<SonarJump | null>(null)

  useEffect(() => {
    if (sent === null) return
    scrollToFinding(sent)
    setSent(null)
  }, [sent])

  const going = sent ?? jump

  return (
    <div className="flex w-full flex-col gap-3">
      {/* Progress and layout on one line, above everything, because both are
          answers you want without opening a file — which is the whole of the
          ticket's third success criterion. */}
      <div className="text-muted-foreground flex flex-wrap items-baseline justify-between gap-4 text-xs">
        <span className="flex items-baseline gap-3">
          {/* Mono, because this is the number you come back to the page for and
              it changes under you as you read: on a shared advance width the
              digits tick in place instead of shifting the words after them. */}
          <span className="font-mono tabular-nums">
            {read} of {changes.files.length} read
          </span>
          {scope.control}
        </span>
        <span className="flex items-baseline gap-3">
          <HideDoneToggle hideDone={hideDone} onHideDoneChange={onHideDoneChange} />
          <WhitespaceToggle
            ignoreWhitespace={ignoreWhitespace}
            onIgnoreWhitespaceChange={onIgnoreWhitespaceChange}
          />
          <LayoutToggle layout={layout} onLayoutChange={onLayoutChange} />
        </span>
      </div>

      {/* Not a `Failed`: the diff below this line is fine and is what the tab is
          for. Saying it once here beats a notice on each of 294 panels. */}
      {threadError === null ? null : (
        <p className="text-muted-foreground text-xs">
          Comments could not be read, so none are shown on these files. {threadError}
        </p>
      )}

      {/* A view that failed or is still arriving renders no rows at all, so
          these say which of the two it is. Falling back to the combined list
          would put every file in the pull request under a heading that says
          "Update 4", which is the one wrong answer these views can give. */}
      {error !== null ? (
        <Failed>Could not load {scope.what}. {error}</Failed>
      ) : pending ? (
        <p className="text-muted-foreground text-xs">Loading {scope.what}…</p>
      ) : changes.files.length === 0 ? (
        <Empty>{scope.empty}</Empty>
      ) : null}

      {/* Above the tree and the panels because it acts on all of them, the same
          argument `InboxControls` makes for one search box over two sections. */}
      {changes.files.length === 0 ? null : (
        <FindBar
          files={ordered}
          diffSource={source}
          term={term}
          onTerm={setTerm}
          onGo={(hit) => setSent({ path: hit.path, line: hit.line })}
        />
      )}

      {/* Beside the find box because it moves the page the same way, through the
          same jump. Mounted with the list rather than always, so the `?` sheet
          dims these keys on a tab that has no files to step through. */}
      {changes.files.length === 0 ? null : (
        <ReviewKeys
          files={ordered}
          isRead={isRead}
          onViewedChange={onViewedChange}
          threads={threads}
          findings={findings}
          onGo={setSent}
        />
      )}

      <div className="flex w-full items-start gap-6">
        <FileTree nodes={nodes} viewed={isRead} conflicted={conflicted} />

        {/* `min-w-0` because the diff inside is wide and a flex child defaults to
            its content's width, which would push the tree off the screen. */}
        <ul aria-label="Changed files" className="flex min-w-0 flex-1 flex-col gap-1">
          {ordered.map((file) => (
            <li key={file.path}>
              <ChangedFileDiff
                diffSource={source}
                file={file}
                layout={layout}
                ignoreWhitespace={ignoreWhitespace}
                conflicted={conflicted.has(file.path)}
                viewed={isRead(file)}
                onViewedChange={(next) => onViewedChange(file, next)}
                // `null` for a file nobody has commented on, which is most of
                // them, and the same `null` the panel gets while the read is
                // still in flight. Both mean "no conversation to place here".
                threads={threads.get(file.path) ?? null}
                threadActions={threadActions}
                hideDone={hideDone}
                iterationContext={iterationContext}
                // Matched on the path here rather than compared inside each panel,
                // so 293 of the 294 are handed the `null` that means "not you".
                // `line` is null on a finding about the file as a whole, and that is
                // the same `null`: the page's scroll was the whole of that jump.
                jumpTo={going !== null && going.path === file.path ? going.line : null}
                webUrl={webUrl}
                find={term}
              />
            </li>
          ))}
        </ul>
      </div>

      {changes.truncated ? (
        <p className="text-muted-foreground text-xs">
          Azure DevOps returned only the first {changes.files.length} files. There are more.
        </p>
      ) : null}
    </div>
  )
}

/**
 * Where a thread hangs, as one string: `path:line`, or the path when ADO gave a
 * file and no position — which is its own way of commenting on a whole file.
 *
 * `leftStart` is read as a fallback because a comment on a deleted line has only
 * that, and printing the file with no line at all would lose the one fact the
 * row is for.
 */
function anchorOf(thread: Thread): { path: string; line: number | null } | null {
  const context = thread.context
  if (context === null) return null

  return {
    path: context.filePath,
    line: context.rightStart?.line ?? context.leftStart?.line ?? null,
  }
}

/**
 * Everything a person said about this pull request — on it, and on its lines.
 *
 * The PR-level half needs somewhere of its own because nothing else can hold it:
 * `fileThreads` keys on a path and those threads have none, and 44 of the 56
 * threads T-022 sampled were exactly this.
 *
 * **The anchored half is here too, and that is a fix rather than a duplication.**
 * This section used to count them — "11 more threads on lines in the diff" — on
 * the reasoning that the place to read a comment about line 40 is line 40. Live,
 * that reasoning cost the section its whole point: on the sampled org every
 * comment a colleague had left was anchored to a line and every one of the
 * reviewer's own was on the pull request, so the page read as "you are the only
 * person who has commented here". A conversation you have to go hunting for
 * across a tab and a collapsed file panel is one you do not know exists. So each
 * anchored thread is rendered here under a `path:line` that jumps to it, and line
 * 40 is still where it is read in full.
 */
function PullRequestConversation({
  conversation,
  hideDone,
  onHideDoneChange,
  onJump,
}: {
  conversation: Conversation
  /** The page's flag, shared with the diff — one answer to "am I hiding resolved threads". */
  hideDone: boolean
  onHideDoneChange: (hideDone: boolean) => void
  /** Where an anchored thread's `path:line` sends the page. */
  onJump: (jump: { path: string; line: number | null }) => void
}) {
  const [composing, setComposing] = useState(false)

  const { onPullRequest, threads } = conversation

  // Same gate the diff's panels get: with no credential the handlers are dropped
  // rather than disabled, because "not offered" is how this seam spells a write
  // that cannot land. `viewerId` stays either way — it is what "your comment"
  // means, and it came down from the page, not from the token.
  const actions: ThreadActions = conversation.connected
    ? conversation.actions
    : { viewerId: conversation.actions.viewerId }
  const onNewThread = actions.onNewThread

  const open = (thread: Thread) => !hideDone || thread.resolution === 'open'

  const shown = onPullRequest.filter(open)
  const shownAnchored = threads.filter((thread) => thread.context !== null && open(thread))

  return (
    <div className="flex w-full flex-col gap-2">
      {/* The same control as the one above the diff and the same state behind it,
          offered here because this is the other place threads are rendered and the
          two tabs are never on screen together. Only when there is something to
          hide: a button that does nothing visible is a button that reads as broken. */}
      {threads.some((thread) => thread.resolution !== 'open') ? (
        <div className="text-muted-foreground flex justify-end text-xs">
          <HideDoneToggle hideDone={hideDone} onHideDoneChange={onHideDoneChange} />
        </div>
      ) : null}

      {shown.length + shownAnchored.length === 0 ? (
        <Empty>
          {threads.length === 0
            ? 'Nothing has been said about this pull request yet.'
            : 'Every thread on this pull request is resolved.'}
        </Empty>
      ) : null}

      {/* One card per thread and not one for the lot: they are not replies to
          each other, and stacking them into a single card would say they were. */}
      {shown.map((thread) => (
        <ThreadCard key={thread.id} threads={[thread]} actions={actions} className="pl-0" />
      ))}

      {shownAnchored.map((thread) => {
        const anchor = anchorOf(thread)

        return (
          <div key={thread.id} className="flex w-full flex-col">
            {/* Mono, because a path and a line number are figures rather than
                prose — the same reading Sonar's occurrence rows are set in. The
                click crosses a tab, so it is a button and not a link: the router
                owns the URL and a `#file…` hash would survive into the back
                button as state nobody meant to keep (see `fileAnchor`). */}
            {anchor === null ? null : (
              <button
                type="button"
                onClick={() => onJump(anchor)}
                title={anchor.line === null ? anchor.path : `${anchor.path}:${anchor.line}`}
                className="text-muted-foreground hover:text-primary max-w-full self-start truncate rounded-sm font-mono text-2xs underline decoration-[1.5px] underline-offset-[3px]"
              >
                {anchor.path}
                {anchor.line === null ? null : `:${anchor.line}`}
              </button>
            )}
            <ThreadCard threads={[thread]} actions={actions} className="pl-0" />
          </div>
        )
      })}

      {/* Said out loud, because these are threads that exist in ADO and are not
          on this page. "No comments" while Sonar has written thirty is the wrong
          answer to "has anyone looked at this". */}
      {conversation.systemCount === 0 && conversation.botCount === 0 ? null : (
        <p className="text-muted-foreground text-xs">
          {[
            conversation.systemCount === 0
              ? null
              : `${conversation.systemCount} Azure DevOps status ${conversation.systemCount === 1 ? 'update' : 'updates'}`,
            conversation.botCount === 0 ? null : `${conversation.botCount} from SonarCloud`,
          ]
            .filter((part) => part !== null)
            .join(' and ')}{' '}
          hidden. The quality gate above is the readable form of the second.
        </p>
      )}

      {onNewThread === undefined ? null : composing ? (
        <Composer
          label="New comment on this pull request"
          autoFocus
          onSubmit={async (content) => {
            // No context and no iteration: this is a comment about the pull
            // request, and giving it either would anchor it to a file it is not
            // about.
            await onNewThread({
              content,
              context: null,
              iterationContext: null,
              status: 'active',
            })
            setComposing(false)
          }}
          onCancel={() => setComposing(false)}
        />
      ) : (
        <div>
          <Button variant="ghost" size="xs" onPress={() => setComposing(true)}>
            Comment on this pull request
          </Button>
        </div>
      )}
    </div>
  )
}

export function PullRequestDetailView({
  pr,
  prRef,
  failed = {},
  sonar = null,
  layout = 'unified',
  onLayoutChange = () => {},
  tab = 'details',
  onTabChange = () => {},
}: {
  pr: PullRequestDetail
  /**
   * The three GUIDs the route was addressed by. `PullRequestDetail` carries the
   * project and repository *names* and not their ids, and the blob call needs
   * ids, so this comes down from the route rather than out of the payload.
   */
  prRef: PullRequestRef
  failed?: FailedSections
  /**
   * `sonarReport({...})` from the route, or `null` while it is still in flight —
   * which is also what a test that does not care about Sonar passes. Fetched
   * there rather than here because this component's other dependency on a server
   * function is the one the route already owns, and because a second service that
   * can be rate-limited for minutes must not be able to hold up this page.
   */
  sonar?: SonarReportResult | null
  /** Owned by the route, because the page widens for side-by-side. */
  layout?: DiffLayout
  onLayoutChange?: (layout: DiffLayout) => void
  /** Owned by the route for the same reason `layout` is: a diff tab widens the container. */
  tab?: DetailTab
  onTabChange?: (tab: DetailTab) => void
}) {
  // Persisted, so closing the tab halfway through a 40-file review does not
  // start it over. Read once per page and written through on each tick.
  const { keys: viewed, pending: viewedPending, setViewed } = useViewedFiles(prRef)

  // One read for the page, polled, and the only thing on it that changes while
  // you are looking at it. Held here rather than in the route — unlike the tab
  // and the layout it changes nothing about the page's shape — and here rather
  // than in `ChangedFiles` because the details tab needs the same answer.
  const conversation = useConversation(prRef, pr.viewerId)

  // Here rather than inside `EditableTitle` so the hook does not depend on which
  // branch that component is rendering, and so the decision about *when* a rename
  // is on offer is made once, next to the header it belongs to.
  const rename = useRename(prRef)

  // Beside `rename` and for its reason: the write is the page's, the busy state
  // is the row's. Held here rather than in the route because the route hands this
  // component the report and nothing else about it.
  const resolveSonar = useSonarResolve(prRef)

  // Per pull request and per visit, not persisted: "hide resolved" is a thing you
  // do on a second pass through a diff somebody has already reviewed, and coming
  // back tomorrow to a page that is quietly hiding half the conversation is a
  // worse default than one click.
  const [hideDone, setHideDone] = useState(false)

  // Beside `hideDone` and for the same reason: the route owns `layout` because
  // side-by-side widens the page, and `-w` changes nothing about its shape. Per
  // visit too — it answers "this change was reformatted", which is a fact about
  // the pull request in front of you and not about how you read.
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(false)

  const iterations = pr.files.iterations
  const latest = iterations[iterations.length - 1]

  // Which update the update tab is on — here rather than in the route because,
  // unlike the tab and the layout, it changes nothing about the page's shape.
  const [chosen, setChosen] = useState<number | null>(null)
  const selected = chosen ?? latest?.id ?? null

  const tabs: readonly TabSpec[] = [
    { id: 'details', label: 'Details' },
    {
      id: 'combined',
      label: 'Combined',
      count: failed.files === true ? undefined : pr.files.files.length,
    },
    ...(iterations.length > 1
      ? ([
          { id: 'update', label: 'By update' },
          { id: 'since', label: 'Since my review' },
        ] as const)
      : []),
  ]

  // A tab that is not on offer cannot be the one we are showing: the two update
  // tabs disappear on a single-update pull request, and the route's state outlives
  // the payload it was chosen against.
  const active = tabs.some((entry) => entry.id === tab) ? tab : 'details'
  const update = active === 'update' && selected !== null ? selected : null

  // Derived on every render and never held, which is note 7 of the map: the
  // thirty-second thread poll answers with a new conversation, and a copy of this
  // taken when the tab was clicked would go on naming an iteration that is no
  // longer the head.
  const review = useMemo(
    () => lastReview(pr.viewerId, conversation.threads, conversation.votes, iterations),
    [pr.viewerId, conversation.threads, conversation.votes, iterations],
  )

  // Only `behind` asks ADO anything. The other two are sentences, and asking for a
  // range to put under them would be asking a question whose answer we already
  // know is empty.
  const since = active === 'since' && review.kind === 'behind' ? review.view : null

  const view: ChangeView =
    since ?? (update === null ? COMBINED : { kind: 'update', iterationId: update })
  const changes = useChanges(prRef, view, pr.files)

  // Which of the three questions the file list is answering, in the three places
  // it has to be said. The range states its basis where the update picker sits,
  // on the line the reader is already reading for the count — and "since your
  // approval" and "since your comment" are different sentences, because one of
  // them means you finished and the other means you were passing through.
  const changeScope: ChangeScope =
    since !== null && review.kind === 'behind'
      ? {
          control: (
            <span>
              Since {review.basis.what} on {onDate(review.basis.at)}
            </span>
          ),
          what: 'the changes since your last review',
          empty:
            'Nothing has changed in the files since then. The pushes since your review only moved the branch pointer — a rebase, or a merge from the target.',
        }
      : update === null
        ? { control: null, what: 'the changed files', empty: 'No files changed.' }
        : {
            control: (
              <UpdatePicker iterations={iterations} selected={update} onSelect={setChosen} />
            ),
            what: 'this update’s changes',
            empty:
              'This update changed no files. A push that only moves the branch pointer — a rebase or a merge from the target — leaves nothing new to read.',
          }

  // The bytes for the first few files, fetched while you are reading the details
  // tab, so that clicking Combined paints a diff instead of starting one. The
  // combined list is what arrives with the page and what a diff tab opens on, so
  // this is the list to warm; how far down it goes, and why it stops there, is
  // `useWarmDiff`'s own header. Off on the diff tabs, where the panels are already
  // fetching the same keys as they scroll into view.
  useWarmDiff(prRef, pr.files.files, active === 'details')

  // Which iterations a thread started on the diff in front of us is written
  // against — the thing that makes "line 40" mean something, since line 40 of
  // update 2 is not line 40 of update 5.
  //
  // `null` on the combined diff, deliberately: ADO anchors a thread with no
  // iteration context against the latest iteration, which is exactly what the
  // combined view's line numbers are. Otherwise it is the pair `useChanges` asked
  // ADO for, `compareTo` and all — read from the same function, so a range and its
  // comments cannot end up describing different diffs.
  const range = viewRange(view)
  const iterationContext = useMemo<IterationContext | null>(
    () =>
      range === null
        ? null
        : {
            firstComparingIteration: range.compareTo,
            secondComparingIteration: range.iterationId,
            // ADO's own way of following a line across iterations, and it was on
            // 5 of the 12 anchored threads sampled. We have no way to compute one
            // from a change entry, so it is left out rather than guessed.
            changeTrackingId: null,
          },
    [range?.compareTo, range?.iterationId],
  )

  // A Sonar finding sits on the details tab and points at a file in the diff, so
  // its click has to cross a tab. Held as state rather than acted on, because the
  // panel it scrolls to does not exist yet: the tab has to render *and* its file
  // list has to arrive, and neither has happened by the time the click returns.
  //
  // Seeded from the URL, because a permalink somebody was sent is the same
  // request arriving from further away: a file and a line, waiting on the tab to
  // render and the list to arrive. The route opens on the diff tab when there is
  // one, so the effect below has a panel to find.
  const [jump, setJump] = useState<SonarJump | null>(readLineTarget)

  // Flattened out of the groups rather than re-derived below, so the keys that
  // step through findings walk them in the order the panel prints them: rule by
  // rule, count descending.
  const findings = useMemo(
    () => sonar?.report?.groups.flatMap((group) => group.findings) ?? [],
    [sonar?.report],
  )

  // The same crossing for both things on the details tab that point at a line: a
  // Sonar finding and, now, a thread anchored to one.
  const goToFile = (next: SonarJump) => {
    setJump(next)
    onTabChange('combined')
  }

  useEffect(() => {
    if (jump === null || active !== 'combined' || changes.pending) return

    scrollToFinding(jump)
    // Once, not on every later render: a stale jump would drag the page back
    // the next time this file list changed underneath it. The line half of the
    // jump outlives this — the panel it names has taken a copy by now and is
    // waiting on its own bytes to act on it (see `ChangedFileDiff`).
    setJump(null)
  }, [jump, active, changes.pending])

  return (
    <article className="flex w-full flex-col items-start gap-5">
      {/* The one drawn card on the page, and the only surface here that keeps
          `.sketch-box`'s shadow. Everything below it — policies, reviewers,
          commits — is `--quiet`, so the page reads as one sheet lifted off the
          paper with a stack of lists under it rather than five competing cards.
          The header is what you look at to know where you are; the lists are
          what you read. */}
      <header className="sketch-box w-full px-4 py-3">
        <div className="flex items-baseline justify-between gap-4">
          {/* Offered while the pull request is `active`, which is the one status
              where its title is still a thing being decided rather than a record of
              what happened. Whether ADO would *allow* a rename on a completed one
              is its own question and not one guessed at here — note `status` is the
              empty string when ADO did not say (see `PullRequestDetail`), and that
              is not active either. */}
          <EditableTitle
            title={pr.title}
            onRename={pr.status === 'active' ? rename : undefined}
          />
          {/* Demoted, not removed: there will always be something only ADO can do. */}
          <a
            href={pr.url}
            target="_blank"
            rel="noreferrer"
            className="text-muted-foreground hover:text-primary shrink-0 text-2xs underline decoration-[1.5px] underline-offset-[3px]"
          >
            Azure DevOps
          </a>
        </div>

        {/* A drawn rule between the title and its provenance, where a `border-t`
            would have gone. `.sketch-rule` and not `.sketch-underline` under the
            title itself: the underline is a 160px drawing stretched with
            `background-size: 100% 8px`, and SVG's default `meet` fitting means
            it clamps at 1× — on a title wider than 160px the stroke stops
            scaling and renders as a short mark floating in the middle of the
            line. The rule tiles a 600px drawing with `repeat-x`, so it is
            correct at any width. */}
        <hr className="sketch-rule my-2" />

        <p className="text-muted-foreground text-xs">
          {/* Everything ADO addresses this pull request by is mono, and the two
              things a person wrote — the author's name and the age — are not.
              That split is the whole reason the line is readable at 12px: the
              identifiers line up as a run of code, the prose stays prose. */}
          <span className="font-mono tabular-nums">!{pr.id}</span>
          {' · '}
          <span className="font-mono">
            {pr.project}/{pr.repository}
          </span>
          {' · '}
          {/* `inline-flex` with `align-middle`, and both are load-bearing on a 12px
              line: a 16px circle dropped into it as a bare inline child sits on the
              baseline and pushes the line's own descenders down, and without the
              wrapper a wrap could put the face at the end of one line and the name
              at the start of the next. */}
          <span className="inline-flex items-center gap-1 align-middle">
            <Avatar href={pr.author.avatarHref} name={pr.author.displayName} className="size-4" />
            {pr.author.displayName}
          </span>
          {' · '}
          <span className="font-mono tabular-nums">{age(pr.createdAt)}</span>
          {' · '}
          {/* Destination first, and the arrow still pointing at it. The pair is
              read to answer "where is this going", and the branch that ends up
              carrying the work is the one worth landing on first — the same way
              round as the assignment it amounts to. Flipping the pair without
              flipping the arrow would have said the exact opposite. */}
          <span className="font-mono">
            {branch(pr.targetBranch)} ← {branch(pr.sourceBranch)}
          </span>{' '}
          {/* The source and not the target, because the target is `main` and nobody
              needs help typing that. */}
          <CopyBranch sourceBranch={branch(pr.sourceBranch)} />
          {pr.isDraft ? <Chip tone="amber">draft</Chip> : null}
        </p>

        {/* The header's write row, under a second rule: above it is what this pull
            request *is*, below it is what you can do about it. Both controls are
            here rather than down the page because both are answers about the pull
            request as a whole — and because the tab strip is directly underneath,
            so anything further down would be an action hidden inside a reading
            surface.

            Vote left, lifecycle right, and far apart: they are the two ends of
            what a reviewer might mean, and the destructive one should not be the
            button next to Reject. */}
        <hr className="sketch-rule my-2" />

        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
          <VoteControl pr={pr} prRef={prRef} />
          <LifecycleControl pr={pr} prRef={prRef} />
        </div>
      </header>

      <TabStrip tab={active} tabs={tabs} onTabChange={onTabChange} />

      {active === 'details' ? (
        <div
          role="tabpanel"
          id="panel-details"
          aria-labelledby="tab-details"
          // No measure cap here, deliberately: this panel is exactly as wide as
          // the diff panel beside it, so switching tabs moves nothing at all. A
          // cap was tried and reverted — it holds the page still but still leaves
          // the *content* changing width, which is the shift you actually see.
          className="flex w-full flex-col items-start gap-5"
        >
          <MergeBanner merge={pr.merge} conflictsError={pr.errors.conflicts} />

          {/* Ahead of the description deliberately: the description measured 1710
              characters on a real PR, and the checklist is the thing the page
              exists to answer. */}
          <Section title="Policies" count={failed.policies === true ? undefined : pr.policies.length}>
            {failed.policies === true ? (
              <Failed>Could not load the branch policies for this pull request.</Failed>
            ) : pr.policies.length === 0 ? (
              <Empty>No branch policies apply to this pull request.</Empty>
            ) : (
              <PolicyChecklist policies={pr.policies} prRef={prRef} />
            )}
          </Section>

          {/* Directly under the checklist, because it is the answer to what the
              checklist asks — and a section of its own, like every other block on
              this page, because it is no longer one button: it is where the
              commit that lands on the target branch gets written. */}
          <Section title="Merge">
            <MergeControl pr={pr} prRef={prRef} failed={failed} />
          </Section>

          {/* Second, and for the same reason the policies are first: a failing
              quality gate is one of the things stopping this from merging. The
              panel renders nothing at all on a pull request with no SonarCloud
              status, which is most of them, so this costs those pages a `null`.

              Its failures are named here rather than inside it. "No token yet" is
              a fact about this app's setup and not about the findings, and only
              this side knows that a missing credential is reachable — `connected`
              can only be false once the pull request has been shown to have a
              Sonar project, because the server reads no token before that. */}
          {sonar === null ? null : !sonar.connected ? (
            <p className="text-muted-foreground text-xs">
              This pull request is analysed by SonarCloud. Add a token in connections and the
              findings will appear here.
            </p>
          ) : sonar.error !== null ? (
            <Failed>Could not read Sonar for this pull request. {sonar.error}</Failed>
          ) : (
            <SonarPanel
              report={sonar.report}
              rules={sonar.rules}
              // ADO's own spelling, leading slash and all, on both sides — the
              // server normalised the Sonar half to it, so this is set membership.
              changedPaths={new Set(pr.files.files.map((file) => file.path))}
              onJump={goToFile}
              actions={resolveSonar}
            />
          )}

          {/* Beside Sonar and above the conversation: both of these answer "is this
              pull request in a state to be read", and the panel owns both of its own
              reads — there is no plumbing to pass it beyond the ref. */}
          <ChecksPanel prRef={prRef} />

          {/* After the two gates and before the people, which is where it sits in
              the order this page is read in: what is blocking the merge, then what
              has been said about it, then who was asked.

              Its own failure, again named here and not inside it — and it is a
              notice rather than a missing section, because the conversation is the
              one part of this page a failed call can take without taking the
              review with it. */}
          <Section
            title="Conversation"
            // Every human thread, not just the PR-level ones: the section renders
            // both now, and a count that disagreed with the list under it would be
            // the same "nobody has commented" the list itself used to tell.
            count={conversation.error !== null ? undefined : conversation.threads.length}
          >
            {conversation.error !== null ? (
              <Failed>
                Could not read the comments on this pull request. {conversation.error}
              </Failed>
            ) : conversation.pending ? (
              <p className="text-muted-foreground text-xs">Loading the conversation…</p>
            ) : (
              <PullRequestConversation
                conversation={conversation}
                hideDone={hideDone}
                onHideDoneChange={setHideDone}
                onJump={goToFile}
              />
            )}
          </Section>

          <Section title="Reviewers" count={pr.reviewers.length}>
            <ReviewerList
              prRef={prRef}
              reviewers={pr.reviewers}
              viewerId={pr.viewerId}
              canWrite={pr.status === 'active'}
            />
          </Section>

          <Section title="Description">
            {pr.description.trim() === '' ? (
              <Empty>No description.</Empty>
            ) : (
              // Whole, and rendered. The inbox's copy stops at 400 characters and
              // that truncation is the entire reason this page fetches the PR — so
              // the full text arriving as its own source, `## Summary` and all, was
              // the last thing standing between the section and being readable.
              // `Markdown` renders no raw HTML; see its header.
              <Markdown>{pr.description}</Markdown>
            )}
          </Section>

          <Section title="Commits" count={failed.commits === true ? undefined : pr.commits.length}>
            {failed.commits === true ? (
              <Failed>Could not load the commits for this pull request.</Failed>
            ) : pr.commits.length === 0 ? (
              <Empty>No commits on this branch.</Empty>
            ) : (
              <ul className="sketch-box sketch-box--quiet w-full">
                {pr.commits.map((commit) => (
                  <CommitRow key={commit.id} commit={commit} />
                ))}
              </ul>
            )}
          </Section>
        </div>
      ) : (
        // No `Section` around this and no heading: the tab is the heading, and it
        // already carries the count. What the diff needs from the page is width.
        <div role="tabpanel" id={`panel-${active}`} aria-labelledby={`tab-${active}`} className="w-full">
          {failed.files === true ? (
            <Failed>Could not load the changed files for this pull request.</Failed>
          ) : viewedPending ? (
            // One tick against a local SQLite table, and it buys the whole of
            // "expanded by default" on a pull request you are coming back to: a
            // panel chooses whether to start open when it mounts, so the list
            // cannot mount before the marks it would be choosing against.
            <p className="text-muted-foreground text-xs">Loading…</p>
          ) : active === 'since' && review.kind !== 'behind' ? (
            // The two answers this tab has that are not a file list, and each is a
            // sentence rather than an empty list under a heading. An empty list
            // says "no files" and leaves the reader to guess whether that means
            // nothing was pushed, or nothing was found, or the call failed.
            <p className="text-muted-foreground text-xs">
              {review.kind === 'none'
                ? review.reason
                : `Nothing has been pushed since ${review.basis.what} on ${onDate(review.basis.at)}. What you read then is what is there now.`}
            </p>
          ) : (
            <ChangedFiles
              changes={changes.changes}
              scope={changeScope}
              pending={changes.pending}
              error={changes.error}
              ref={prRef}
              conflicted={new Set(pr.merge.conflicts.map((conflict) => conflict.path))}
              layout={layout}
              onLayoutChange={onLayoutChange}
              ignoreWhitespace={ignoreWhitespace}
              onIgnoreWhitespaceChange={setIgnoreWhitespace}
              viewed={viewed}
              onViewedChange={setViewed}
              threads={conversation.files}
              // Offered only when the write can actually go out. `connected` is
              // false when there is no credential, and a composer that can only
              // fail is worse than no composer.
              threadActions={conversation.connected ? conversation.actions : undefined}
              threadError={conversation.error}
              hideDone={hideDone}
              onHideDoneChange={setHideDone}
              iterationContext={iterationContext}
              jump={jump}
              findings={findings}
              webUrl={pr.url}
            />
          )}
        </div>
      )}
    </article>
  )
}
