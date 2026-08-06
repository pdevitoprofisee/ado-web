import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { hashKey, useQueryClient } from '@tanstack/react-query'
import { TextField } from 'react-aria-components'
import { ArrowDown01Icon, ArrowUp01Icon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'

import { useCommand } from '@/commands/command-provider'
import { SEARCHES, findInDiff, findSentence } from '@/lib/diff-find'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Kbd } from '@/components/ui/kbd'

import type { KeyboardEvent } from 'react'
import type { FindHit, FindTarget } from '@/lib/diff-find'
import type { BlobAnswer, DiffSource } from '@/lib/diff-source'
import type { ChangedFile } from '@/server/pull-request'

// Find, over the whole change set rather than over the rows the virtualizer left
// in the document.
//
// The bytes it searches are already paid for: every panel that has come near the
// viewport put its two blobs in the query cache, and this reads them back through
// the same source object the panels fetch with — never by spelling the key again,
// which is the one rule `blob-query.ts` exists to keep.
//
// Stepping is deliberately not a search-as-you-type scroll. A stop reveals
// collapsed context and scrolls a virtualized list, so doing it on every keystroke
// would drag the page around while somebody is still deciding what to look for.
// Typing counts; Enter and the two buttons move.

/**
 * The after-side text of every file in `files`, as far as the cache has it.
 *
 * The cache and not the panels, because a panel is the wrong thing to ask: it
 * knows whether *it* has bytes, and there is no list of panels — 294 of them are
 * children of a `map` and none of them report upwards. The cache holds the same
 * answer for all of them and can be read without rendering anything.
 *
 * Re-read when an entry lands, so a file that loads while the box is open joins
 * the count instead of waiting for an unrelated render. Only while something is
 * being searched for: a subscription that runs all the time would wake this on
 * every poll for the whole life of the page.
 */
function useLoadedText(
  files: readonly ChangedFile[],
  diffSource: DiffSource,
  active: boolean,
): readonly FindTarget[] {
  const client = useQueryClient()
  const [landed, noteLanded] = useReducer((count: number) => count + 1, 0)

  // The shas, not the array: the page polls every ~30 s and hands down a fresh
  // `files` each time for a diff that has not moved. The same trick `useWarmDiff`
  // plays on the same list, and for the same reason.
  const fingerprint = files.map((file) => `${file.path}@${file.objectId}`).join(' ')

  useEffect(() => {
    if (!active) return

    const watched = new Set(files.map((file) => hashKey(diffSource.blobsOptions(file).queryKey)))

    return client.getQueryCache().subscribe((event) => {
      if (event.type !== 'updated' || event.action.type !== 'success') return
      if (watched.has(hashKey(event.query.queryKey))) noteLanded()
    })
    // `files` is read through `fingerprint`, and `diffSource` is rebuilt inline by
    // the page on every render — depending on either would resubscribe constantly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fingerprint, active, client])

  return useMemo(
    () =>
      files.map((file) => {
        const answer = client.getQueryData<BlobAnswer>(diffSource.blobsOptions(file).queryKey)
        const after = answer?.blobs?.after

        // A binary, a file the source refused, and a file nobody has fetched are
        // all the same thing to a search: no text, and a file it must own up to
        // not having read.
        return { path: file.path, lines: after?.kind === 'text' ? after.lines : null }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fingerprint, landed, client],
  )
}

export function FindBar({
  files,
  diffSource,
  term,
  onTerm,
  onGo,
}: {
  /** The change set, in the order the page lists it. Hits come back in that order. */
  files: readonly ChangedFile[]
  /** How the panels below fetch. Used to read their cache, never to fill it. */
  diffSource: DiffSource
  term: string
  onTerm: (next: string) => void
  /** Send the reader to this line. The page's job — see `ChangedFiles`. */
  onGo: (hit: FindHit) => void
}) {
  const box = useRef<HTMLInputElement>(null)
  const targets = useLoadedText(files, diffSource, term !== '')
  const result = useMemo(() => findInDiff(targets, term), [targets, term])

  // Which hit the reader is standing on, or -1 for "has typed, has not moved".
  // Reset when the term changes, because the hit that was third is now nothing.
  const [at, setAt] = useState(-1)

  useCommand('find.diff', () => {
    box.current?.focus()
    // Selected rather than appended to: `/` on a box that already says something
    // is nearly always the start of a different search.
    box.current?.select()
  })

  const total = result.hits.length
  // Bytes arriving under an open box can shorten the list — a smaller diff for a
  // file whose panel was showing the wrong iteration's blobs, say — so where the
  // reader was standing may no longer exist.
  const standing = at >= 0 && at < total ? at : -1

  function step(delta: number) {
    if (total === 0) return

    const next = standing === -1 ? (delta > 0 ? 0 : total - 1) : (standing + delta + total) % total
    setAt(next)
    onGo(result.hits[next])
  }

  // Escape belongs to the box rather than to `nav.back`, because the command
  // layer ignores every key typed into a text field. Two presses to leave, in the
  // order `InboxControls` settled on: clear first, since that is the common
  // intent, and only then give the keyboard back to the page.
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      step(event.shiftKey ? -1 : 1)
      return
    }

    if (event.key !== 'Escape') return
    if (term === '') {
      event.currentTarget.blur()
      return
    }
    onTerm('')
    setAt(-1)
  }

  return (
    <div className="flex w-full flex-wrap items-center gap-3">
      <TextField
        aria-label={`Find in ${SEARCHES}`}
        value={term}
        onChange={(next) => {
          onTerm(next)
          setAt(-1)
        }}
        className="max-w-sm flex-1"
      >
        <Input ref={box} type="search" placeholder="Find in the diff" onKeyDown={onKeyDown} />
      </TextField>

      <span className="flex items-center gap-1">
        <Button
          variant="outline"
          size="icon-xs"
          aria-label="Previous match"
          isDisabled={total === 0}
          onPress={() => step(-1)}
        >
          <HugeiconsIcon icon={ArrowUp01Icon} size={14} aria-hidden />
        </Button>
        <Button
          variant="outline"
          size="icon-xs"
          aria-label="Next match"
          isDisabled={total === 0}
          onPress={() => step(1)}
        >
          <HugeiconsIcon icon={ArrowDown01Icon} size={14} aria-hidden />
        </Button>
      </span>

      {/* The count and the blind spot together, from one function, because they
          are one fact — see `findSentence`. Mounted empty rather than
          conditionally, so the live region exists before it has anything to say:
          a region inserted along with its text is one several screen readers
          never announce. */}
      <p role="status" className="text-muted-foreground flex items-baseline gap-2 text-xs">
        {term === '' ? null : (
          <>
            {standing === -1 ? null : (
              <span className="font-mono tabular-nums">
                {standing + 1} of {total}
              </span>
            )}
            <span>{findSentence(result)}</span>
          </>
        )}
      </p>

      <span className="text-muted-foreground ml-auto text-xs">
        <Kbd>/</Kbd> to find
      </span>
    </div>
  )
}
