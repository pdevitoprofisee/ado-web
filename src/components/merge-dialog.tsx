import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { TextArea, TextField } from 'react-aria-components'

import { pullRequestQuery } from '@/server/pull-request-fn'
import { CADENCE } from '@/lib/cadence'
import {
  OVERRIDE_LABEL,
  branch,
  commitMessage,
  defaultDraft,
  mergeBlocker,
  useSquashMerge,
} from '@/lib/merge'
import { pullRequestKey } from '@/lib/requeue'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
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

import type { CommitDraft } from '@/lib/merge'
import type { AddressableRow } from './pr-list'

// The inbox's squash merge. One dialog for the whole table rather than one per
// row: the row's button only says which pull request, and everything the write
// needs — the commit message, and whether Azure DevOps will take it at all —
// belongs to the pull request that was chosen.
//
// **The dialog reads the pull request before it offers anything.** The row cannot
// answer either question. `readyToMerge` on a row is the inbox's weaker test,
// documented there as "worth opening to merge", and `row.description` is the list
// endpoint's first 400 characters — truncated mid-word, with no flag saying so. A
// commit body prefilled from that would be a commit body missing its end. So the
// read happens once when the dialog opens, under the detail page's own query key,
// and `mergeBlocker` gets the same payload it gets there.

/**
 * The squash merge, from the table.
 *
 * Mounted for as long as the inbox is, and drawn only while a row is chosen. That
 * is what keeps a typed message alive across a dismissal: Escape and a click
 * outside are the cancel path for a confirmation, and `pr-detail.tsx` records why
 * they must not be the delete key for a paragraph somebody just wrote. The draft
 * is held out here, above the part that closes, and keyed by pull request — so
 * reopening the same row finds the message again, and a different row starts from
 * its own title.
 *
 * @param onMerged Run after ADO accepted the merge, with the row it merged. The
 * inbox's cue to drop that row, which is the one thing this component cannot do
 * for itself.
 */
export function MergeDialog({
  row,
  onClose,
  onMerged,
}: {
  row: AddressableRow | null
  onClose: () => void
  onMerged: (row: AddressableRow) => void
}) {
  const [edited, setEdited] = useState<{ id: number; draft: CommitDraft } | null>(null)

  if (row === null) return null

  return (
    <MergeSheet
      // A fresh read, a fresh message and no leftover refusal when the reviewer
      // moves to another row.
      key={row.id}
      row={row}
      edited={edited?.id === row.id ? edited.draft : null}
      onEdit={(draft) => setEdited({ id: row.id, draft })}
      onClose={onClose}
      onMerged={onMerged}
    />
  )
}

function MergeSheet({
  row,
  edited,
  onEdit,
  onClose,
  onMerged,
}: {
  row: AddressableRow
  /** The message as typed, or `null` while it is still Azure DevOps' wording. */
  edited: CommitDraft | null
  onEdit: (draft: CommitDraft) => void
  onClose: () => void
  onMerged: (row: AddressableRow) => void
}) {
  const prRef = { projectId: row.projectId, repositoryId: row.repositoryId, id: row.id }

  // The detail page's key and the detail page's staleness, so opening this on a
  // pull request that was just read costs nothing and merging from here corrects
  // the page too. Not polled: this dialog is open for a minute at most, and the
  // write re-reads on its own way out.
  // On by default, for `MergeControl`'s reason, and reset with the dialog: this
  // component is keyed by row, so moving to another pull request asks the
  // question again rather than carrying an answer across.
  const [override, setOverride] = useState(true)

  const query = useQuery({
    queryKey: pullRequestKey(prRef),
    queryFn: () => pullRequestQuery({ data: prRef }),
    staleTime: CADENCE.pullRequest,
  })
  const merge = useSquashMerge(prRef, () => onMerged(row))

  const result = query.data
  const pr = result?.pullRequest ?? null
  // Derived, never seeded into state: a refetch while the dialog is open must not
  // write over what is in the box.
  const draft = edited ?? (pr === null ? null : defaultDraft(pr))
  const message = draft === null ? '' : commitMessage(draft)

  const refusal = pr === null || result === undefined ? null : mergeBlocker(pr, result.failed)
  // The box is offered only where Azure DevOps' override would clear the refusal
  // — `MergeControl` says why — which is also what keeps `bypassPolicy` off a
  // completion that needed no override.
  const canOverride = refusal?.overridable === true
  const bypassPolicy = canOverride && override
  const blocker = bypassPolicy ? null : (refusal?.reason ?? null)
  // `mergeBlocker` answers a question about the pull request; this one is about
  // what is in the box. Keyed on the subject, because a body with no subject line
  // composes to a commit whose first line is somebody's second thought.
  const unwritten =
    draft !== null && draft.subject.trim() === ''
      ? 'A commit needs a message. Write its first line above.'
      : null
  const stopping = blocker ?? unwritten
  // Which of the two places says why: an overridable refusal is written on the
  // box that clears it, not twice.
  const because =
    stopping === null
      ? undefined
      : canOverride && blocker !== null
        ? 'merge-override'
        : 'merge-blocked'

  const sha = pr?.lastMergeSourceCommit ?? null

  return (
    <Dialog
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      // Open exactly while a write is in flight: dismissing then would hide the
      // outcome of something that has already been sent.
      isDismissable={!merge.isPending}
      showCloseButton={false}
      // Wider than the default sketch dialog, which is sized for a sentence. This
      // one holds a commit body that came out of a pull request description.
      className="sm:max-w-xl"
    >
      <DialogHeader>
        <DialogTitle>Squash and merge?</DialogTitle>
        <DialogDescription className="flex flex-col gap-2">
          {/* From the row, so the dialog names what it is about before the read
              lands. A confirmation that does not say which pull request is a
              confirmation people click through. */}
          <p>
            <span className="font-mono tabular-nums">!{row.id}</span> {row.title}
          </p>
          {pr === null ? null : (
            <p>
              Every commit on <span className="font-mono">{branch(pr.sourceBranch)}</span> becomes
              one commit on <span className="font-mono">{branch(pr.targetBranch)}</span>.{' '}
              <span className="font-mono">{branch(pr.sourceBranch)}</span> is deleted — its work
              lives on in the squashed commit, and Azure DevOps can restore the branch afterwards.
              Completing a pull request cannot be undone
              {bypassPolicy ? '.' : ', and no policy is bypassed.'}
            </p>
          )}
          {/* The rule being broken, in the dialog's strongest voice, because a
              confirmation that lists everything except that is the wrong half of
              the truth. */}
          {bypassPolicy && refusal !== null ? (
            <p className="text-foreground">
              The branch policies are overridden: {refusal.reason} Azure DevOps records the override
              on the pull request, and refuses the completion outright unless this token may bypass
              policies on the target branch.
            </p>
          ) : null}
        </DialogDescription>
      </DialogHeader>

      {query.isPending ? (
        <p className="text-muted-foreground text-sm">
          Reading <span className="font-mono">!{row.id}</span>…
        </p>
      ) : null}

      {/* The read's three failures, in the detail route's own words but one line
          each: this is a dialog, and the reviewer's next move in all three cases
          is to close it. */}
      {result !== undefined && !result.connected ? (
        <p className="text-destructive text-sm">
          There is no Azure DevOps token yet, so this pull request could not be read.
        </p>
      ) : null}
      {result?.notFound === true ? (
        <p className="text-destructive text-sm">
          Azure DevOps does not have a pull request !{row.id} here any more.
        </p>
      ) : null}
      {result?.connected === true && result.error !== null && !result.notFound ? (
        <p className="text-destructive text-sm">Azure DevOps did not answer: {result.error}</p>
      ) : null}
      {query.isError ? (
        <p className="text-destructive text-sm">
          The pull request could not be read: {query.error.message}
        </p>
      ) : null}

      {draft !== null && blocker === null ? (
        <div className="flex flex-col gap-3">
          {/* Subject and body as two fields, for `MergeControl`'s reason: the
              first line is what every shortlog and every ADO commit list shows,
              and a single textarea would let it silently become two lines.
              `lib/merge.ts` puts the blank line between them. */}
          <TextField
            className="flex w-full flex-col gap-1.5"
            value={draft.subject}
            onChange={(subject) => onEdit({ ...draft, subject })}
          >
            <Label>Merge commit message</Label>
            <Input />
          </TextField>

          <TextField
            className="flex w-full flex-col gap-1.5"
            value={draft.body}
            onChange={(body) => onEdit({ ...draft, body })}
          >
            <Label>Description</Label>
            {/* `Input`'s chrome grown downward, as on the detail page: a
                description copied out of the pull request can be four lines or
                forty. */}
            <TextArea
              rows={4}
              className="field-sizing-content min-h-20 w-full resize-y rounded-sm border-[1.5px] border-input bg-popover px-2.5 py-1.5 text-base outline-none md:text-sm"
            />
          </TextField>
        </div>
      ) : null}

      {/* Azure DevOps' own checkbox, in Azure DevOps' own words, carrying the
          refusal it would clear. */}
      {canOverride && refusal !== null ? (
        <Checkbox isSelected={override} onChange={setOverride}>
          <span className="flex flex-col gap-0.5">
            <span>{OVERRIDE_LABEL}</span>
            <span id="merge-override" className="text-muted-foreground text-xs">
              {refusal.reason} Azure DevOps records the override on the pull request.
            </span>
          </span>
        </Checkbox>
      ) : null}

      {because === 'merge-blocked' ? (
        <p id="merge-blocked" className="text-muted-foreground text-xs">
          {stopping}
        </p>
      ) : null}

      {merge.error === null ? null : (
        // ADO's own words. A refusal here names the policy, or says the source
        // branch has moved, and no sentence of ours could carry that.
        <p role="alert" className="text-destructive text-sm">
          Azure DevOps did not merge it: {merge.error}
        </p>
      )}

      <DialogFooter>
        {/* Cancel first in the DOM, so the dialog opens with focus on the way out
            rather than on the irreversible half. */}
        <DialogClose isDisabled={merge.isPending}>Cancel</DialogClose>
        <Button
          isDisabled={merge.isPending || stopping !== null || sha === null || message === ''}
          aria-describedby={because}
          onPress={() => {
            // Narrowing, not defence: a null tip is one of `mergeBlocker`'s own
            // refusals, so the button is disabled before this can be reached.
            if (sha !== null) {
              merge.run({ lastMergeSourceCommit: sha, commitMessage: message, bypassPolicy })
            }
          }}
        >
          {merge.isPending ? 'Merging…' : 'Squash and merge'}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
