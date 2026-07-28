import { Check, CircleHelp, Clock, Minus, TriangleAlert, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import type { ReactNode } from 'react'

import { age } from './pr-list'
import { Markdown } from './markdown'
import { Composer } from './comments/composer'
import { ThreadCard } from './comments/thread-card'
import { ChangedFileDiff } from './diff/changed-file'
import { FileTree } from './diff/file-tree'
import { SonarPanel, scrollToFinding } from './sonar/panel'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { COMBINED, useChanges } from '@/lib/changes'
import { useConversation } from '@/lib/conversation'
import { buildFileTree, treeFiles } from '@/lib/file-tree'
import { cn } from '@/lib/utils'
import { useViewedFiles } from '@/lib/viewed'
import { fileViewedKey } from '@/lib/viewed-key'

import type { ThreadActions } from './comments/thread-actions'
import type { SonarJump } from './sonar/panel'
import type { ChangeView } from '@/lib/changes'
import type { FileThreads, IterationContext } from '@/lib/comment-contract'
import type { Conversation } from '@/lib/conversation'
import type { DiffLayout } from '@/lib/diff-contract'
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

function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="text-muted-foreground border-border ml-1.5 rounded border px-1 text-[10px] uppercase">
      {children}
    </span>
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
      <h2
        aria-label={count === undefined ? undefined : `${title}, ${count}`}
        className="text-muted-foreground mb-1 flex items-baseline gap-2 text-xs font-medium tracking-wide uppercase"
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
      <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
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
        <TriangleAlert aria-hidden />
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

function PolicyIcon({ status }: { status: PolicyStatus }) {
  switch (status) {
    case 'approved':
      return <Check className="size-3.5 shrink-0" aria-hidden />
    case 'rejected':
    case 'broken':
      return <X className="text-destructive size-3.5 shrink-0" aria-hidden />
    case 'queued':
    case 'running':
      return <Clock className="size-3.5 shrink-0" aria-hidden />
    case 'notApplicable':
      return <Minus className="size-3.5 shrink-0" aria-hidden />
    default:
      return <CircleHelp className="size-3.5 shrink-0" aria-hidden />
  }
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

function PolicyRow({ policy, ambiguous }: { policy: Policy; ambiguous: boolean }) {
  return (
    <li className="border-border/60 flex items-baseline gap-2 border-b px-2 py-1 text-sm last:border-b-0">
      <PolicyIcon status={policy.status} />
      <span className="min-w-0 flex-1">
        {policy.name}
        {policy.detail === null ? null : (
          <span className="text-muted-foreground"> — {policy.detail}</span>
        )}
        {ambiguous ? (
          <span className="text-muted-foreground font-mono text-xs"> #{policy.id}</span>
        ) : null}
      </span>
      {policy.url === null ? null : (
        <a
          href={policy.url}
          target="_blank"
          rel="noreferrer"
          className="text-muted-foreground shrink-0 text-xs underline underline-offset-4"
        >
          result
        </a>
      )}
      <span className="text-muted-foreground w-24 shrink-0 text-right text-xs">
        {POLICY_WORDS[policy.status]}
      </span>
    </li>
  )
}

function PolicyChecklist({ policies }: { policies: readonly Policy[] }) {
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
            <h3
              className={cn(
                'mb-1 text-xs font-medium',
                name === 'Blocking' ? 'text-destructive' : 'text-muted-foreground',
              )}
            >
              {name}
            </h3>
            <ul aria-label={name} className="border-border/60 rounded-md border">
              {buckets[index].map((policy) => (
                <PolicyRow
                  key={policy.id}
                  policy={policy}
                  ambiguous={(counts.get(label(policy)) ?? 0) > 1}
                />
              ))}
            </ul>
          </div>
        ),
      )}
    </div>
  )
}

/** ADO's vote scale is five integers; this is what they mean. */
const VOTES = new Map<number, string>([
  [10, 'approved'],
  [5, 'approved with suggestions'],
  [0, 'no vote'],
  [-5, 'waiting for author'],
  [-10, 'rejected'],
])

export function voteWord(vote: number): string {
  return VOTES.get(vote) ?? `vote ${vote}`
}

function ReviewerRow({ reviewer, viewerId }: { reviewer: Reviewer; viewerId: string | null }) {
  return (
    <li className="border-border/60 flex items-baseline gap-2 border-b px-2 py-1 text-sm last:border-b-0">
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
          that reads teams as a footnote reads almost empty on a real PR. */}
      <span
        className={cn(
          'w-16 shrink-0 text-right text-xs',
          reviewer.isRequired ? 'font-medium' : 'text-muted-foreground',
        )}
      >
        {reviewer.isRequired ? 'required' : 'optional'}
      </span>
      <span className="w-44 shrink-0 text-right text-xs">{voteWord(reviewer.vote)}</span>
    </li>
  )
}

function CommitRow({ commit }: { commit: Commit }) {
  return (
    <li className="border-border/60 flex items-baseline gap-2 border-b px-2 py-1 text-sm last:border-b-0">
      <a
        href={commit.url}
        target="_blank"
        rel="noreferrer"
        className="text-muted-foreground w-16 shrink-0 font-mono text-xs"
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
      <span
        className="text-muted-foreground w-16 shrink-0 text-right text-xs tabular-nums"
        title={commit.at}
      >
        {age(commit.at)}
      </span>
    </li>
  )
}

/**
 * Unified or side-by-side, for every file at once.
 *
 * One control for the whole page rather than one per file: the choice is about
 * how you read, not about the file in front of you, and `setLayout` reprojects
 * an already-expanded file rather than starting it over, so flipping it mid-read
 * costs nothing and loses nothing.
 */
function LayoutToggle({
  layout,
  onLayoutChange,
}: {
  layout: DiffLayout
  onLayoutChange: (layout: DiffLayout) => void
}) {
  return (
    <div role="group" aria-label="Diff layout" className="flex items-baseline gap-2">
      {(['unified', 'split'] as const).map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={layout === option}
          onClick={() => onLayoutChange(option)}
          className={cn(
            'rounded px-1.5 py-0.5',
            layout === option ? 'text-foreground bg-muted' : 'hover:text-foreground',
          )}
        >
          {option === 'unified' ? 'Unified' : 'Side by side'}
        </button>
      ))}
    </div>
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
      className="border-input bg-background max-w-full rounded border px-1.5 py-0.5 text-xs"
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

/** The three things this page can be showing. */
export type DetailTab = 'details' | 'combined' | 'update'

interface TabSpec {
  readonly id: DetailTab
  readonly label: string
  readonly count?: number
}

/**
 * Details, the combined diff, or one update.
 *
 * Details leads and is the default because of what this page is for: the answer to
 * "what is stopping this from merging" comes before the diff, not after it. The two
 * diff tabs exist so that when you do go to read the code you get the whole window
 * for it — a tree down one side and eighty columns of it — instead of the bottom
 * third of a page whose top is a policy checklist you have already read.
 *
 * "By update" is absent on a single-update pull request, nearly half of them
 * measured, because there the two diffs are the same files and offering a choice
 * between them only invites the reader to look for a difference.
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
    <div
      role="tablist"
      aria-label="Pull request"
      className="border-border/60 flex w-full items-baseline gap-1 border-b text-sm"
    >
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
          className={cn(
            '-mb-px flex items-baseline gap-1.5 rounded-t border-b-2 px-2 py-1',
            tab === id
              ? 'border-foreground text-foreground'
              : 'text-muted-foreground hover:text-foreground border-transparent',
          )}
        >
          {label}
          {count === undefined ? null : (
            <span className="text-muted-foreground text-xs tabular-nums">{count}</span>
          )}
        </button>
      ))}
    </div>
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
      className={cn(
        'rounded px-1.5 py-0.5',
        hideDone ? 'text-foreground bg-muted' : 'hover:text-foreground',
      )}
    >
      Hide resolved
    </button>
  )
}

function ChangedFiles({
  changes,
  update,
  pending,
  error,
  ref,
  conflicted,
  layout,
  onLayoutChange,
  viewed,
  onViewedChange,
  threads,
  threadActions,
  threadError,
  hideDone,
  onHideDoneChange,
  iterationContext,
}: {
  /** The selected view's files — the combined diff, or one update's. */
  changes: ChangeSet
  /** The update picker, when this is an update's diff — and the word the empty state needs. */
  update: ReactNode | null
  pending: boolean
  error: string | null
  ref: PullRequestRef
  /** Conflict paths match `changeEntries[].item.path` exactly, so the banner's
      files can be found again in the list they actually live in. */
  conflicted: ReadonlySet<string>
  layout: DiffLayout
  onLayoutChange: (layout: DiffLayout) => void
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

  return (
    <div className="flex w-full flex-col gap-3">
      {/* Progress and layout on one line, above everything, because both are
          answers you want without opening a file — which is the whole of the
          ticket's third success criterion. */}
      <div className="text-muted-foreground flex flex-wrap items-baseline justify-between gap-4 text-xs">
        <span className="flex items-baseline gap-3">
          <span className="tabular-nums">
            {read} of {changes.files.length} read
          </span>
          {update}
        </span>
        <span className="flex items-baseline gap-3">
          <HideDoneToggle hideDone={hideDone} onHideDoneChange={onHideDoneChange} />
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

      {/* An update that failed or is still arriving renders no rows at all, so
          these say which of the two it is. Falling back to the combined list
          would put every file in the pull request under a heading that says
          "Update 4", which is the one wrong answer this view can give. */}
      {error !== null ? (
        <Failed>Could not load this update&rsquo;s changes. {error}</Failed>
      ) : pending ? (
        <p className="text-muted-foreground text-xs">Loading this update&rsquo;s changes…</p>
      ) : changes.files.length === 0 ? (
        <Empty>
          {update === null
            ? 'No files changed.'
            : 'This update changed no files. A push that only moves the branch pointer — a rebase or a merge from the target — leaves nothing new to read.'}
        </Empty>
      ) : null}

      <div className="flex w-full items-start gap-6">
        <FileTree nodes={nodes} viewed={isRead} conflicted={conflicted} />

        {/* `min-w-0` because the diff inside is wide and a flex child defaults to
            its content's width, which would push the tree off the screen. */}
        <ul aria-label="Changed files" className="flex min-w-0 flex-1 flex-col gap-1">
          {ordered.map((file) => (
            <li key={file.path}>
              <ChangedFileDiff
                projectId={ref.projectId}
                repositoryId={ref.repositoryId}
                id={ref.id}
                file={file}
                layout={layout}
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
 * The conversation that is about the pull request rather than about a line.
 *
 * It needs somewhere of its own because nothing else can hold it: `fileThreads`
 * keys on a path and these threads have none, and 44 of the 56 threads T-022
 * sampled were exactly this. A page that only rendered comments inside diff rows
 * would be hiding most of what was said.
 */
function PullRequestConversation({
  conversation,
  hideDone,
  onHideDoneChange,
}: {
  conversation: Conversation
  /** The page's flag, shared with the diff — one answer to "am I hiding resolved threads". */
  hideDone: boolean
  onHideDoneChange: (hideDone: boolean) => void
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

  const shown = hideDone
    ? onPullRequest.filter((thread) => thread.resolution === 'open')
    : onPullRequest

  // Everything else is anchored, so it is on the other tab. Counted rather than
  // repeated here: the place to read a comment about line 40 is line 40.
  const onFiles = threads.length - onPullRequest.length

  return (
    <div className="flex w-full flex-col gap-2">
      {/* The same control as the one above the diff and the same state behind it,
          offered here because this is the other place threads are rendered and the
          two tabs are never on screen together. Only when there is something to
          hide: a button that does nothing visible is a button that reads as broken. */}
      {onPullRequest.some((thread) => thread.resolution !== 'open') ? (
        <div className="text-muted-foreground flex justify-end text-xs">
          <HideDoneToggle hideDone={hideDone} onHideDoneChange={onHideDoneChange} />
        </div>
      ) : null}

      {shown.length === 0 ? (
        <Empty>
          {onPullRequest.length === 0
            ? 'Nothing has been said about this pull request yet.'
            : 'Every thread on this pull request is resolved.'}
        </Empty>
      ) : (
        // One card per thread and not one for the lot: they are not replies to
        // each other, and stacking them into a single card would say they were.
        shown.map((thread) => (
          <ThreadCard key={thread.id} threads={[thread]} actions={actions} className="pl-0" />
        ))
      )}

      {/* Both said out loud, because both are threads that exist in ADO and are
          not on this page. "No comments" while eleven sit in the diff, or while
          Sonar has written thirty, is the wrong answer to "has anyone looked at
          this". */}
      {onFiles === 0 ? null : (
        <p className="text-muted-foreground text-xs">
          {onFiles} more {onFiles === 1 ? 'thread' : 'threads'} on lines in the diff.
        </p>
      )}
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

  // Per pull request and per visit, not persisted: "hide resolved" is a thing you
  // do on a second pass through a diff somebody has already reviewed, and coming
  // back tomorrow to a page that is quietly hiding half the conversation is a
  // worse default than one click.
  const [hideDone, setHideDone] = useState(false)

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
    ...(iterations.length > 1 ? ([{ id: 'update', label: 'By update' }] as const) : []),
  ]

  // A tab that is not on offer cannot be the one we are showing: the update tab
  // disappears on a single-update pull request, and the route's state outlives
  // the payload it was chosen against.
  const active = tabs.some((entry) => entry.id === tab) ? tab : 'details'
  const update = active === 'update' && selected !== null ? selected : null

  const view: ChangeView = update === null ? COMBINED : { kind: 'update', iterationId: update }
  const changes = useChanges(prRef, view, pr.files)

  // Which iterations a thread started on the diff in front of us is written
  // against — the thing that makes "line 40" mean something, since line 40 of
  // update 2 is not line 40 of update 5.
  //
  // `null` on the combined diff, deliberately: ADO anchors a thread with no
  // iteration context against the latest iteration, which is exactly what the
  // combined view's line numbers are. An update's diff is the pair `useChanges`
  // asked ADO for, `compareTo` and all.
  const iterationContext = useMemo<IterationContext | null>(
    () =>
      update === null
        ? null
        : {
            firstComparingIteration: update - 1,
            secondComparingIteration: update,
            // ADO's own way of following a line across iterations, and it was on
            // 5 of the 12 anchored threads sampled. We have no way to compute one
            // from a change entry, so it is left out rather than guessed.
            changeTrackingId: null,
          },
    [update],
  )

  // A Sonar finding sits on the details tab and points at a file in the diff, so
  // its click has to cross a tab. Held as state rather than acted on, because the
  // panel it scrolls to does not exist yet: the tab has to render *and* its file
  // list has to arrive, and neither has happened by the time the click returns.
  const [jump, setJump] = useState<SonarJump | null>(null)

  useEffect(() => {
    if (jump === null || active !== 'combined' || changes.pending) return

    scrollToFinding(jump)
    // Once, not on every later render: a stale jump would drag the page back
    // the next time this file list changed underneath it.
    setJump(null)
  }, [jump, active, changes.pending])

  return (
    <article className="flex w-full flex-col items-start gap-5">
      <header className="w-full">
        <div className="flex items-baseline justify-between gap-4">
          <h1 className="text-xl leading-tight font-semibold tracking-tight">{pr.title}</h1>
          {/* Demoted, not removed: there will always be something only ADO can do. */}
          <a
            href={pr.url}
            target="_blank"
            rel="noreferrer"
            className="text-muted-foreground shrink-0 text-xs underline underline-offset-4"
          >
            Azure DevOps
          </a>
        </div>
        <p className="text-muted-foreground mt-1 text-xs">
          <span className="font-mono tabular-nums">!{pr.id}</span>
          {' · '}
          {pr.project}/{pr.repository}
          {' · '}
          {pr.author.displayName}
          {' · '}
          {age(pr.createdAt)}
          {' · '}
          <span className="font-mono">
            {branch(pr.sourceBranch)} → {branch(pr.targetBranch)}
          </span>
          {pr.isDraft ? <Chip>draft</Chip> : null}
        </p>
      </header>

      <TabStrip tab={active} tabs={tabs} onTabChange={onTabChange} />

      {active === 'details' ? (
        <div
          role="tabpanel"
          id="panel-details"
          aria-labelledby="tab-details"
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
              <PolicyChecklist policies={pr.policies} />
            )}
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
              onJump={(next) => {
                setJump(next)
                onTabChange('combined')
              }}
            />
          )}

          {/* After the two gates and before the people, which is where it sits in
              the order this page is read in: what is blocking the merge, then what
              has been said about it, then who was asked.

              Its own failure, again named here and not inside it — and it is a
              notice rather than a missing section, because the conversation is the
              one part of this page a failed call can take without taking the
              review with it. */}
          <Section
            title="Conversation"
            count={conversation.error !== null ? undefined : conversation.onPullRequest.length}
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
              />
            )}
          </Section>

          <Section title="Reviewers" count={pr.reviewers.length}>
            {pr.reviewers.length === 0 ? (
              <Empty>Nobody has been asked to review this.</Empty>
            ) : (
              <ul className="border-border/60 w-full rounded-md border">
                {pr.reviewers.map((reviewer) => (
                  <ReviewerRow key={reviewer.id} reviewer={reviewer} viewerId={pr.viewerId} />
                ))}
              </ul>
            )}
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
              <ul className="border-border/60 w-full rounded-md border">
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
          ) : (
            <ChangedFiles
              changes={changes.changes}
              update={
                update === null ? null : (
                  <UpdatePicker iterations={iterations} selected={update} onSelect={setChosen} />
                )
              }
              pending={changes.pending}
              error={changes.error}
              ref={prRef}
              conflicted={new Set(pr.merge.conflicts.map((conflict) => conflict.path))}
              layout={layout}
              onLayoutChange={onLayoutChange}
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
            />
          )}
        </div>
      )}
    </article>
  )
}
