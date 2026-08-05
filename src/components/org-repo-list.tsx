import { useEffect, useId, useMemo, useState } from 'react'
import { TextField } from 'react-aria-components'
import {
  Cancel01Icon,
  Copy01Icon,
  GitBranchIcon,
  LinkSquare02Icon,
  Tick02Icon,
} from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'

import { useCommand } from '@/commands/command-provider'
import { Input } from '@/components/ui/input'
import { filterRepositories } from '@/lib/repository-search'
import { cn } from '@/lib/utils'

import type { KeyboardEvent } from 'react'
import type { RepositoryRow } from '@/lib/repositories-contract'

// Every repository in the organisation, as a searchable flat list. Split out of
// the route the way `repo-list.tsx` and `pr-list.tsx` are: the route's other job
// is fetching, and a list is only testable on its own once it has nothing to
// fetch.
//
// **This is the Azure DevOps list, and `/repos` is the local one.** Neither claims
// to be the other's — a repository on this disk has a HEAD, a target and
// uncommitted files, and a repository in the organisation has a clone URL and a
// project. Joining the two on the origin URL is a later ticket.
//
// **There is no "last updated" column** and the page does not imply one exists.
// T-046 read every field of all 114 rows: the repository carries no timestamp at
// all, and the only date in the response belongs to the *project*. A column would
// cost one call per repository — 114 of them, about 7.5 seconds serial — so it is
// a hydration ticket if it is ever wanted, not a field somebody can fill in.
//
// **Every row is a link out.** There is no in-app file browser, so the row's
// primary action opens the repository in Azure DevOps and the secondary one puts
// the clone URL on the clipboard, which is the other reason to be on this page.

/** Long enough to be seen, short enough that the row goes back to being a row. */
const COPIED_FOR = 2000

/**
 * Puts `remoteUrl` on the clipboard, verbatim.
 *
 * `Profisee@` prefix and all: that prefix is what makes the string work when it is
 * pasted into `git clone`, and a helpfully tidied one is a support question.
 *
 * Three states on one control, drawn as three icons, exactly as `CopyBranch` does
 * on the pull request page — a hundred rows of prose is not what this list is for.
 * The accessible name carries the whole meaning including the repository, because
 * "copy" on 114 identical buttons does not say which one.
 */
function CopyClone({ row }: { row: RepositoryRow }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')

  const label =
    state === 'copied'
      ? `Copied clone URL for ${row.name}`
      : state === 'failed'
        ? `Failed to copy clone URL for ${row.name}`
        : `Copy clone URL for ${row.name}`

  useEffect(() => {
    if (state === 'idle') return

    const timer = setTimeout(() => setState('idle'), COPIED_FOR)

    return () => clearTimeout(timer)
  }, [state])

  async function copy() {
    // Typed as always there by lib.dom and absent in fact: the Clipboard API is
    // gated on a secure context, so a plain-http LAN address has no
    // `navigator.clipboard` at all. jsdom has none either, which makes this the
    // path the tests get without arranging anything.
    const clipboard: Clipboard | undefined = navigator.clipboard
    if (clipboard === undefined) {
      setState('failed')
      return
    }

    try {
      await clipboard.writeText(row.cloneUrl)
      setState('copied')
    } catch {
      // Permission refused, or a document the browser does not consider focused.
      // Caught rather than allowed out: an unhandled rejection would leave a red
      // console and a control that silently did nothing.
      setState('failed')
    }
  }

  return (
    <button
      type="button"
      onClick={() => void copy()}
      aria-label={label}
      title={label}
      // The visible half of the state. A control that only acknowledges to a
      // screen reader has not acknowledged.
      data-state={state}
      className={cn(
        'shrink-0 rounded-sm px-2 py-1.5',
        state === 'idle' && 'text-muted-foreground hover:text-primary',
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

/**
 * The default branch, or the absence of one said out loud.
 *
 * All 114 rows in this organisation carried one, and the field is still optional
 * because Azure DevOps omits it for a repository with no commits. Amber and a
 * sentence rather than a blank cell: an empty repository is a fact about the
 * repository, not a gap in the list.
 */
function DefaultBranch({ row }: { row: RepositoryRow }) {
  if (row.defaultBranch === undefined) {
    return <span className="text-pen-amber shrink-0 truncate text-xs">no commits yet</span>
  }

  return (
    <span className="text-muted-foreground flex min-w-0 shrink-0 items-center gap-1 font-mono text-xs sm:w-40">
      <HugeiconsIcon icon={GitBranchIcon} size={12} className="shrink-0" aria-hidden />
      <span className="truncate">{row.defaultBranch}</span>
    </span>
  )
}

/** `SaaS/PC.IAC.Networking` — unique across the organisation, unlike the name. */
export const repoKey = (row: RepositoryRow): string => `${row.project}/${row.name}`

/** A row's link, found the way the row is tagged. */
const linkOf = (key: string): HTMLElement | null =>
  // Escaped because a project name can hold a space and a repository name a dot,
  // and a selector is the one place in this file they are not just text.
  document.querySelector(`[data-repo-key="${CSS.escape(key)}"] a`)

function Row({ row, isSelected }: { row: RepositoryRow; isSelected: boolean }) {
  return (
    <li
      // How the selection finds this row in the DOM to focus it, and how a test
      // reads which row is selected.
      data-repo-key={repoKey(row)}
      aria-current={isSelected ? true : undefined}
      className={cn(
        'border-border flex items-center border-b last:border-b-0',
        isSelected ? 'bg-accent rounded-sm' : 'hover:bg-accent/50 hover:rounded-sm',
      )}
    >
      {/* `webUrl`, which is neither `remoteUrl` nor `url` — the last of which is
          the API address and would open JSON in a tab. */}
      <a
        href={row.webUrl}
        target="_blank"
        rel="noreferrer"
        title={`${repoKey(row)} · open in Azure DevOps`}
        // `rounded-sm` on the anchor and not only on the row, for `pr-list.tsx`'s
        // reason: Prof's focus ring is a box-shadow that follows whatever radius
        // it finds, and this is the element the keyboard focuses all day.
        className="flex min-w-0 flex-1 items-baseline gap-x-3 rounded-sm px-2 py-1.5 text-sm"
      >
        <span className="min-w-0 flex-1 truncate font-mono">{row.name}</span>
        <span className="text-muted-foreground hidden shrink-0 truncate text-xs sm:block sm:max-w-40">
          {row.project}
        </span>
        <DefaultBranch row={row} />
        {/* Shown, marked. Eleven of 114 are disabled, and dropping them makes
            this count disagree with Azure DevOps' own. */}
        {row.isDisabled ? (
          <span className="prof-badge prof-badge--amber tracking-label text-2xs shrink-0 px-1.5 py-0.5 leading-none uppercase">
            disabled
          </span>
        ) : null}
        {row.isFork ? (
          <span className="prof-badge prof-badge--navy tracking-label text-2xs shrink-0 px-1.5 py-0.5 leading-none uppercase">
            fork
          </span>
        ) : null}
        <HugeiconsIcon
          icon={LinkSquare02Icon}
          size={12}
          className="text-muted-foreground shrink-0"
          aria-hidden
        />
      </a>
      <CopyClone row={row} />
    </li>
  )
}

/**
 * Keyboard selection over whatever the search has left, keyed by
 * `project/name`.
 *
 * `nav.open` opens the tab itself rather than letting the focused anchor do it:
 * the command layer calls `preventDefault()` on every key it handles, so the
 * anchor's own Enter never fires. `noreferrer` is passed for the same reason it is
 * on the row — `window.open` without it hands the ADO tab a `window.opener`.
 */
function useOrgRepoSelection(rows: readonly RepositoryRow[]): string | null {
  const [selected, setSelected] = useState<string | null>(null)

  const move = (step: number) => {
    if (rows.length === 0) return
    const at = rows.findIndex((row) => repoKey(row) === selected)
    if (at === -1) {
      setSelected(repoKey(step > 0 ? rows[0] : rows[rows.length - 1]))
      return
    }
    setSelected(repoKey(rows[Math.min(Math.max(at + step, 0), rows.length - 1)]))
  }

  useCommand('nav.next', () => move(1))
  useCommand('nav.previous', () => move(-1))
  useCommand('nav.open', () => {
    const row = rows.find((one) => repoKey(one) === selected)
    if (row === undefined) return

    window.open(row.webUrl, '_blank', 'noreferrer')
  })
  // Escape means "never mind" in a list: there is no row-level state to back out
  // of, so it drops the selection rather than navigating anywhere.
  useCommand('nav.back', () => {
    if (selected === null) return
    const focused = linkOf(selected)
    setSelected(null)
    if (document.activeElement === focused) focused?.blur()
  })

  // Moving focus rather than only painting a highlight: it is what puts the row
  // in front of a screen reader, and it scrolls the row into view for free.
  useEffect(() => {
    if (selected === null) return
    const row = linkOf(selected)
    row?.focus()
    // Absent in jsdom, and the selection is still correct without it.
    row?.scrollIntoView?.({ block: 'nearest' })
  }, [selected])

  return selected
}

export function OrgRepositoryList({
  rows,
  /** ADO's own count, before any row was dropped or filtered. */
  returned,
}: {
  rows: readonly RepositoryRow[]
  returned: number
}) {
  const [query, setQuery] = useState('')
  const listId = useId()
  // The whole list is in hand, so this is local, immediate, and has no debounce,
  // no minimum length and nothing to cancel — `reviewer-picker.tsx`'s bargain.
  const shown = useMemo(() => filterRepositories(rows, query), [rows, query])
  const selected = useOrgRepoSelection(shown)

  // Escape is handled here rather than through `nav.back`, because the command
  // layer deliberately ignores keys typed into a text field (`isTextEntry`). In
  // the box, "never mind" means the search rather than the selection.
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Escape') return
    if (query === '') {
      event.currentTarget.blur()
      return
    }
    setQuery('')
  }

  return (
    <section className="flex w-full flex-col gap-3" aria-label="Organisation repositories">
      {/* **Not autofocused**, and that is the one deliberate difference from
          `reviewer-picker.tsx`, which is. The command layer ignores every key
          typed into a text field (`isTextEntry`), so a focused filter would take
          `j`, `k` and Enter away from the list for as long as it held focus —
          on a page whose whole content is a list you navigate. It is the first
          focusable thing in the main content, so it is one Tab away. */}
      <TextField aria-label="Search repositories" value={query} onChange={setQuery}>
        <Input
          type="search"
          placeholder="Repository or project"
          aria-controls={listId}
          onKeyDown={onKeyDown}
          className="max-w-sm"
        />
      </TextField>

      <div>
        {/* Labelled, because the flex gap between the word and the count is
            whitespace only to the eye. `.annotation` carries the style, so the
            heading reads as the label on a drawing rather than a second title. */}
        <h2
          aria-label={`Repositories, ${shown.length} of ${returned}`}
          className="annotation flex items-baseline gap-2"
        >
          Repositories
          <span className="tabular-nums">
            {shown.length === returned ? returned : `${shown.length} of ${returned}`}
          </span>
        </h2>
        <div className="sketch-rule mt-1 mb-1.5" aria-hidden />

        {/* Three different emptinesses, and the search one must not read as "this
            organisation has no repositories". A filtered-to-zero list says what
            was typed. */}
        {returned === 0 ? (
          <p className="text-muted-foreground px-2 py-1.5 text-sm">
            Azure DevOps returned no repositories for this organisation.
          </p>
        ) : shown.length === 0 ? (
          <p className="text-muted-foreground px-2 py-1.5 text-sm">
            No repository matches <code className="font-mono text-xs">{query}</code>. Searching{' '}
            {returned} across the organisation, by name and project.
          </p>
        ) : (
          // The list is a sheet raised off the desk. `p-1` is the gutter that keeps
          // a washed row's organic corners — and its focus ring — off the box's own
          // edge, which `overflow-hidden` would have clipped instead.
          <ul id={listId} className="sketch-box sketch-box--quiet p-1">
            {shown.map((row) => (
              <Row key={repoKey(row)} row={row} isSelected={repoKey(row) === selected} />
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}
