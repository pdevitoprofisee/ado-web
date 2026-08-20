import { WorkItemPicker } from './picker'
import { Empty, Failed } from '@/components/notes'
import { useWorkItems } from '@/lib/work-items'

import type { WorkItem } from '@/lib/work-item-contract'
import type { PullRequestRef } from '@/server/pull-request'

// What this pull request is for, according to the board.
//
// **This component fetches its own data**, `ChecksPanel`'s arrangement and for the
// same two reasons: the read is two ADO calls the page must not wait on to draw a
// title, and the picker underneath needs to invalidate that read alone after a
// write. The wiring is one line in `pr-detail.tsx` and nothing in the route.
//
// The section is called "Work items" rather than "Tickets" because that is the
// word on the page a row leads to.

function WorkItemRow({ item }: { item: WorkItem }) {
  return (
    <li className="border-border flex items-baseline gap-2 border-b px-2 py-1.5 text-sm last:border-b-0">
      {/* The whole row is not the link. The number is, `CommitRow`'s arrangement:
          leaving Azure DevOps is a deliberate act, and a title that navigates on a
          stray click is a title you stop reading. */}
      <a
        href={item.url}
        target="_blank"
        rel="noreferrer"
        className="text-muted-foreground hover:text-primary shrink-0 font-mono text-2xs"
      >
        {item.id}
      </a>
      <span className="truncate">{item.title === '' ? 'Untitled' : item.title}</span>
      {/* ADO's own words for both, untranslated: `State` is per work item type and
          per process template, so a lookup table here would be wrong on the first
          project that renamed a column. */}
      <span className="annotation text-muted-foreground ml-auto shrink-0">
        {[item.type, item.state].filter((word) => word !== '').join(' · ')}
      </span>
    </li>
  )
}

/**
 * The work items attached to one pull request, and the control that attaches more.
 *
 * `canWrite` is the pull request being active, decided at the call site the way
 * `ReviewerList`'s is.
 */
export function WorkItemsPanel({
  prRef,
  canWrite,
}: {
  prRef: PullRequestRef
  canWrite: boolean
}) {
  const query = useWorkItems(prRef)
  const answer = query.data

  // The whole app is disconnected, and the page above this has already said so
  // somewhere with room to explain it.
  if (answer !== undefined && !answer.connected) return null

  // Two ways to fail and one sentence for both, `useChecks`' rule: the server
  // function catching an ADO error, and the call never arriving.
  const error = answer?.error ?? query.error?.message ?? null
  const items = answer?.items ?? []
  // The count is what the pull request claims, not what arrived — and it is only
  // claimed when the read that produces it happened. "Work items 0" beside "could
  // not read the work items" reads as a pull request with none, which is the
  // opposite of what is known.
  const total = answer?.total ?? 0
  const counted = error === null && !query.isPending
  const missing = total - items.length

  return (
    <section className="w-full" aria-label="Work items">
      <h2
        aria-label={counted ? `Work items, ${total}` : undefined}
        className="annotation text-ink mb-1.5 flex items-baseline gap-2"
      >
        Work items
        {counted ? <span className="tabular-nums">{total}</span> : null}
      </h2>

      <div className="flex w-full flex-col gap-2">
        {/* Failed → pending → Empty → content, the order every section on this page
            reads in. */}
        {error !== null ? (
          <Failed>Could not read the work items on this pull request. {error}</Failed>
        ) : query.isPending ? (
          <p className="text-muted-foreground text-xs">Reading the work items…</p>
        ) : items.length === 0 ? (
          <Empty>No work item is attached to this pull request.</Empty>
        ) : (
          <ul aria-label="Attached work items" className="sketch-box sketch-box--quiet w-full">
            {items.map((item) => (
              <WorkItemRow key={item.id} item={item} />
            ))}
          </ul>
        )}

        {/* The gap `WorkItemsResult` exists to make visible: a work item that was
            deleted, or lives in a project this credential cannot see, is attached
            and has no row. Silence there would read as a shorter list. */}
        {error === null && missing > 0 ? (
          <Failed>
            {missing} of {total} could not be looked up. They may be deleted, or in a project this
            token cannot read.
          </Failed>
        ) : null}

        {canWrite ? (
          <WorkItemPicker prRef={prRef} attached={new Set(items.map((item) => item.id))} />
        ) : null}
      </div>
    </section>
  )
}
