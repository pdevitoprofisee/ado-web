import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ChangedFileDiff } from './changed-file'
import { adoDiffSource, useWarmDiff } from '@/lib/blob-query'
import { fileAnchor } from '@/lib/file-anchor'

import type { ReactElement } from 'react'
import type { FileBlobs } from '@/lib/diff-contract'
import type { ChangedFile, PullRequestRef } from '@/server/pull-request'

// The seam between the four phase-3 pieces, tested with three of them real. The
// blob call is mocked because it is the network; the diff, the row model and
// the view are the actual ones, because a test that mocked those would only be
// checking that props travel.
vi.mock('@/server/blob-fn', () => ({ fileBlobsQuery: vi.fn() }))
vi.mock('@/lib/highlight/shared', () => ({
  sharedHighlighter: () => ({ highlight: async () => [], dispose: () => {} }),
}))

const { fileBlobsQuery } = await import('@/server/blob-fn')
const call = vi.mocked(fileBlobsQuery)

/**
 * Whether the stubbed observer says its target is on screen.
 *
 * `true` for most of this file, because the list expands every panel from the
 * start and a panel that is being read is a panel that fetches. The two tests
 * about *not* fetching set it false — which is also jsdom's own answer, since it
 * implements no `IntersectionObserver` at all.
 */
let inView = true

// Same reason as diff-view.test.tsx: virtual-core's `getRect` reads
// `offsetWidth`/`offsetHeight`, and jsdom reports 0 for both.
beforeEach(() => {
  call.mockReset()
  inView = true
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  // Synchronous where the real one is not, which is the point: `observe` is
  // called from an effect, so the panel knows on its first commit whether it is
  // being looked at and the test needs no extra tick to find out.
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(private readonly notify: IntersectionObserverCallback) {}
      observe(target: Element) {
        if (!inView) return
        this.notify(
          [{ isIntersecting: true, target } as IntersectionObserverEntry],
          this as unknown as IntersectionObserver,
        )
      }
      unobserve() {}
      disconnect() {}
    },
  )
  for (const [property, value] of [
    ['offsetHeight', 800],
    ['offsetWidth', 1000],
  ] as const) {
    Object.defineProperty(HTMLElement.prototype, property, { configurable: true, value })
  }
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** The three GUIDs the route addresses the page by, shared with the warmer below. */
const REF: PullRequestRef = {
  projectId: '11111111-1111-1111-1111-111111111111',
  repositoryId: '22222222-2222-2222-2222-222222222222',
  id: 24698,
}

const FILE: ChangedFile = {
  path: '/src/log.ts',
  changeType: ['edit'],
  originalPath: null,
  objectId: 'a'.repeat(40),
  originalObjectId: 'b'.repeat(40),
}

const BLOBS: FileBlobs = {
  path: FILE.path,
  before: { kind: 'text', lines: ['keep', 'was here'], bytes: 14, noFinalNewline: false },
  after: { kind: 'text', lines: ['keep', 'is here'], bytes: 13, noFinalNewline: false },
  renamedOnly: false,
}

function answer(blobs: FileBlobs | null, error: string | null = null) {
  return { blobs, error, connected: true, rateLimit: null }
}

function draw(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

function panel(props: Partial<Parameters<typeof ChangedFileDiff>[0]> = {}) {
  return (
    <ChangedFileDiff
      // The real Azure DevOps source over the same `REF`, not a stub: the key it
      // builds is the one the mocked server function is asked through, and the
      // name it carries is the one the failure sentences below expect.
      diffSource={adoDiffSource(REF)}
      file={FILE}
      layout="unified"
      {...props}
    />
  )
}

const header = () => screen.getByRole('button', { name: /log\.ts/ })

describe('ChangedFileDiff', () => {
  it('is open from the start but fetches nothing until it is looked at', async () => {
    // Both halves of the same bargain. Files are expanded so that scrolling the
    // list reads like a diff instead of like a directory, and the bytes are still
    // deferred, because a 294-file pull request expanded eagerly is 588 ADO calls
    // spent before anyone has read a line.
    inView = false
    draw(panel())

    expect(header()).toHaveAttribute('aria-expanded', 'true')
    expect(call).not.toHaveBeenCalled()

    // The header is the other trigger, and on a file already scrolled past and
    // shut it is the only one left.
    await userEvent.click(header())
    await userEvent.click(header())

    expect(call).toHaveBeenCalledTimes(1)
  })

  it('can be found by the file tree, which jumps by id rather than by ref', () => {
    inView = false
    const { container } = draw(panel())

    expect(container.querySelector(`#${fileAnchor(FILE.path)}`)).not.toBeNull()
  })

  it('fetches once when it comes into view, and shows the diff it came back with', async () => {
    call.mockResolvedValue(answer(BLOBS))
    draw(panel())

    await waitFor(() => expect(screen.getByRole('region', { name: FILE.path })).toBeInTheDocument())
    expect(screen.getByRole('region', { name: FILE.path })).toHaveTextContent('is here')
    expect(call).toHaveBeenCalledTimes(1)
    expect(call).toHaveBeenCalledWith({
      data: {
        projectId: '11111111-1111-1111-1111-111111111111',
        repositoryId: '22222222-2222-2222-2222-222222222222',
        id: 24698,
        path: FILE.path,
        objectId: FILE.objectId,
        originalObjectId: FILE.originalObjectId,
      },
    })
  })

  it('does not refetch a file that is closed and opened again', async () => {
    // The ticket asks for both halves of this: opening does not refetch what is
    // already here, and closing does not throw away what it cost to get.
    call.mockResolvedValue(answer(BLOBS))
    draw(panel())

    await waitFor(() => expect(screen.getByRole('region', { name: FILE.path })).toBeInTheDocument())
    await userEvent.click(header())
    await userEvent.click(header())

    expect(screen.getByRole('region', { name: FILE.path })).toHaveTextContent('is here')
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('says the file is loading rather than that it is empty', () => {
    // The placeholder blobs are absent on both sides, and `blobNotice` would
    // otherwise call a file nobody has fetched yet "nothing to show".
    call.mockReturnValue(new Promise(() => {}))
    draw(panel())

    expect(screen.getByText('Loading…')).toBeVisible()
    expect(screen.queryByText('Nothing to show for this file.')).toBeNull()
  })

  it('shows what went wrong when the call could not be made', async () => {
    call.mockResolvedValue(answer(null, 'No Azure DevOps token is stored yet.'))
    draw(panel())

    await waitFor(() =>
      expect(screen.getByText('No Azure DevOps token is stored yet.')).toBeVisible(),
    )
    expect(screen.queryByRole('region', { name: FILE.path })).toBeNull()
  })

  it('shows what went wrong when the server function itself threw', async () => {
    call.mockRejectedValue(new Error('fetch failed'))
    draw(panel())

    await waitFor(() => expect(screen.getByText('fetch failed')).toBeVisible())
  })

  it('reprojects an open file when the layout changes, without fetching again', async () => {
    call.mockResolvedValue(answer(BLOBS))
    const { rerender } = draw(panel())

    await waitFor(() => expect(screen.getByRole('region', { name: FILE.path })).toBeInTheDocument())

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    rerender(<QueryClientProvider client={client}>{panel({ layout: 'split' })}</QueryClientProvider>)

    // Side by side puts the delete and the add on one row, so the two texts
    // that were on separate rows in unified are now on the same one.
    await waitFor(() =>
      expect(screen.getByRole('region', { name: FILE.path })).toHaveTextContent('was here'),
    )
    expect(screen.getByRole('region', { name: FILE.path })).toHaveTextContent('is here')
  })

  it('re-diffs when ignore whitespace is flipped, without fetching again', async () => {
    // The other half of the toggle, and the half that is not in `diff.ts`: the
    // two blobs are content-addressed and already in hand, so turning the flag on
    // is a re-diff and nothing else. A flip that reached the network would be a
    // second call for bytes that cannot have changed.
    //
    // The re-indented `keep` is the line under test. With the flag off it is a
    // delete and an add like any other; with it on it is context, and only the
    // real edit is left. Counted off the panel's own label rather than by reading
    // rows, because the count is the diff and the rows are one way of drawing it.
    call.mockResolvedValue(
      answer({
        path: FILE.path,
        before: { kind: 'text', lines: ['keep', 'was here'], bytes: 14, noFinalNewline: false },
        after: { kind: 'text', lines: ['    keep', 'is here'], bytes: 17, noFinalNewline: false },
        renamedOnly: false,
      }),
    )
    // Held rather than made fresh by `draw`, so the re-render below is the same
    // panel changing its mind and not a new one mounting against a warm cache.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const show = (ignoreWhitespace: boolean) => (
      <QueryClientProvider client={client}>{panel({ ignoreWhitespace })}</QueryClientProvider>
    )
    const { rerender } = render(show(false))

    await waitFor(() => expect(screen.getByLabelText('2 added, 2 removed')).toBeInTheDocument())

    rerender(show(true))

    await waitFor(() => expect(screen.getByLabelText('1 added, 1 removed')).toBeInTheDocument())
    // Drawn from the after side, which is where the four spaces come from — see
    // `emit`. The bytes are the file's either way; the flag only decides whose.
    expect(screen.getByRole('region', { name: FILE.path })).toHaveTextContent('keep')
    expect(call).toHaveBeenCalledTimes(1)

    // And back, because a one-way toggle is not a toggle.
    rerender(show(false))

    await waitFor(() => expect(screen.getByLabelText('2 added, 2 removed')).toBeInTheDocument())
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('renders a non-text outcome as itself instead of as an empty diff', async () => {
    call.mockResolvedValue(
      answer({ ...BLOBS, before: { kind: 'absent' }, after: { kind: 'binary', bytes: 750 } }),
    )
    draw(panel())

    await waitFor(() =>
      expect(screen.getByText('Binary file. There is nothing to show as text.')).toBeVisible(),
    )
    expect(screen.queryByRole('region', { name: FILE.path })).toBeNull()
  })

  it('renders a rename that moved no bytes as a rename', async () => {
    const renamed: ChangedFile = {
      ...FILE,
      path: '/src/sink.ts',
      changeType: ['rename'],
      originalPath: '/src/drain.ts',
    }
    call.mockResolvedValue(
      answer({
        path: renamed.path,
        before: { kind: 'absent' },
        after: { kind: 'absent' },
        renamedOnly: true,
      }),
    )
    draw(panel({ file: renamed }))

    await waitFor(() =>
      expect(screen.getByText('Renamed. The contents did not change.')).toBeVisible(),
    )
    expect(screen.getByRole('button', { name: /← \/src\/drain\.ts/ })).toBeInTheDocument()
  })

  it('starts shut on a file already marked read', () => {
    // What "expanded by default" has to mean on a page you come back to: the
    // panel's own default is "open unless already read", and the pass you did
    // yesterday should still be out of the way.
    inView = false
    draw(panel({ viewed: true }))

    expect(header()).toHaveAttribute('aria-expanded', 'false')
    expect(call).not.toHaveBeenCalled()
  })

  it('paints a file the page warmed, without asking for it itself', async () => {
    // Both sides of the prefetch in one test, which is the only place they can be
    // held honest: `useWarmDiff` writes, this panel reads, and a key spelled
    // differently in either would look like a warm cache while being two entries
    // and two sets of calls. The panel is never scrolled to and never clicked, so
    // its own query is disabled — whatever it renders, it did not fetch.
    inView = false
    call.mockResolvedValue(answer(BLOBS))
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    function Warm() {
      useWarmDiff(REF, [FILE], true)

      return null
    }

    const warming = render(
      <QueryClientProvider client={client}>
        <Warm />
      </QueryClientProvider>,
    )
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    // Leaving the page the warmer lives on must not throw the bytes away: that is
    // what `gcTime: Infinity` is for, and it is half of what makes this a warm-up
    // rather than a race.
    warming.unmount()

    render(<QueryClientProvider client={client}>{panel()}</QueryClientProvider>)

    await waitFor(() =>
      expect(screen.getByRole('region', { name: FILE.path })).toHaveTextContent('is here'),
    )
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('says in words which line the jump landed on', async () => {
    // The jump is dispatched by the page before this panel has any bytes — the
    // scroll to the file is what starts the fetch — so the line has to be held
    // here until there is a model to spend it on. Line 2 is the added line.
    call.mockResolvedValue(answer(BLOBS))
    draw(panel({ jumpTo: 2 }))

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Jumped to line 2.'))
  })

  it('says plainly when the line is not in this diff', async () => {
    // Half the feature, and not an error: Sonar analyses the merge result while
    // this shows the iteration (note 6), so a finding on a line the diff does not
    // contain is routine. Landing on the file and saying nothing would read as
    // having landed on the wrong line.
    call.mockResolvedValue(answer(BLOBS))
    draw(panel({ jumpTo: 214 }))

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Line 214 is not in this diff.'),
    )
  })

  it('opens the collapsed context a line was hiding in', async () => {
    // A hundred lines with one change near the bottom, so line 5 is inside the
    // leading gap and has no row at all until the gap goes. Without the reveal the
    // scroll lands on the nearest row that does exist and says it succeeded.
    const lines = Array.from({ length: 100 }, (_, at) => `line ${at + 1}`)
    const after = lines.slice()
    after[89] = 'line 90 changed'
    call.mockResolvedValue(
      answer({
        path: FILE.path,
        before: { kind: 'text', lines, bytes: 800, noFinalNewline: false },
        after: { kind: 'text', lines: after, bytes: 808, noFinalNewline: false },
        renamedOnly: false,
      }),
    )
    draw(panel({ jumpTo: 5 }))

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Jumped to line 5.'))
    expect(screen.queryByRole('button', { name: 'Expand 86 hidden lines' })).toBeNull()
  })

  it('keeps the live region there before there is anything to say in it', async () => {
    // A live region inserted into the page together with its own text is a region
    // several screen readers never announce, and this sentence is the whole of what
    // they get on arrival.
    call.mockResolvedValue(answer(BLOBS))
    draw(panel())

    await waitFor(() => expect(screen.getByRole('region', { name: FILE.path })).toBeInTheDocument())
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
  })

  it('marks a file viewed without its bytes ever arriving', async () => {
    // Progress has to be recordable from the list, which means the checkbox
    // works on a file whose bytes were never fetched.
    inView = false
    const onViewedChange = vi.fn()
    draw(panel({ onViewedChange }))

    await userEvent.click(screen.getByRole('checkbox', { name: 'Viewed' }))

    expect(onViewedChange).toHaveBeenCalledWith(true)
    expect(call).not.toHaveBeenCalled()
  })
})

describe('a link to one line', () => {
  // The pull request's own `url`, as ADO hands it back. Only ever asserted as a
  // prefix here: what the rest of the address should say is the one thing about
  // this feature nobody has checked in a browser, and a test that pinned it would
  // be checking the guess against itself. See `ado-line-url.ts`.
  const WEB_URL = 'https://dev.azure.com/profisee/SaaS/_git/platform/pullrequest/24698'

  /** Line 2 is the added line — see `BLOBS`. */
  const copy = () => screen.getByRole('button', { name: 'Copy a link to line 2' })

  afterEach(() => {
    // The stub `userEvent.setup()` installs is torn down with it; one put here by
    // hand is not, and would follow the suite into the next file.
    Reflect.deleteProperty(navigator, 'clipboard')
  })

  async function ready(props: Partial<Parameters<typeof ChangedFileDiff>[0]> = {}) {
    call.mockResolvedValue(answer(BLOBS))
    const user = userEvent.setup()
    draw(panel(props))

    await waitFor(() => expect(screen.getByRole('region', { name: FILE.path })).toBeInTheDocument())

    return user
  }

  /** Installed after `setup()`, which puts a stub of its own on `navigator`. */
  function clipboard(writeText: () => Promise<void>) {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  }

  it('copies the page it is on, at the line the button is beside', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    const user = await ready()
    clipboard(writeText)

    await user.click(copy())

    expect(writeText).toHaveBeenCalledTimes(1)
    // The address as it stands plus the fragment, so the link opens the diff the
    // reader is looking at rather than some canonical version of it.
    expect(writeText).toHaveBeenCalledWith(
      `${window.location.href}#path=%2Fsrc%2Flog.ts&line=2`,
    )
  })

  it('says that it copied, and which line', async () => {
    // The whole feedback there is. A 16px button the pointer has already left
    // cannot report anything itself, and a copy that says nothing is
    // indistinguishable from a button that is broken.
    const user = await ready()
    clipboard(vi.fn().mockResolvedValue(undefined))

    await user.click(copy())

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Copied a link to line 2.'),
    )
  })

  it('says it could not when there is no clipboard to write to', async () => {
    // Plain http over the LAN is not a secure context, so the API is absent
    // rather than refusing — and the reader has to be told, because otherwise
    // they paste whatever was in the clipboard before.
    const user = await ready()
    Reflect.deleteProperty(navigator, 'clipboard')

    await user.click(copy())

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Could not copy a link to line 2.'),
    )
  })

  it('says it could not when the write is refused', async () => {
    const user = await ready()
    clipboard(vi.fn().mockRejectedValue(new Error('Document is not focused.')))

    await user.click(copy())

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Could not copy a link to line 2.'),
    )
  })

  it('takes the copy sentence back down and leaves the jump behind it', async () => {
    // One live region for both, so the copy has to hand it back — a file jumped
    // into and then copied from should still say where the reader is.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const user = await ready({ jumpTo: 2 })
      clipboard(vi.fn().mockResolvedValue(undefined))

      await user.click(copy())
      await waitFor(() =>
        expect(screen.getByRole('status')).toHaveTextContent('Copied a link to line 2.'),
      )

      await vi.advanceTimersByTimeAsync(2000)

      await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Jumped to line 2.'))
    } finally {
      vi.useRealTimers()
    }
  })

  it('offers Azure DevOps when the page has an address there', async () => {
    await ready({ webUrl: WEB_URL })

    const link = screen.getByRole('link', { name: 'Open line 2 in Azure DevOps' })

    expect(link).toHaveAttribute('href', expect.stringContaining(WEB_URL))
    expect(link).toHaveAttribute('target', '_blank')
  })

  it('offers nothing there at all on a diff read off the disk', async () => {
    // Absent rather than dead. A branch compare and a commit diff are handed no
    // `webUrl` because there is no Azure DevOps address for either, and that is
    // what has to take the link off the row — not a link that opens the wrong
    // thing, and not one that opens nothing.
    await ready()

    expect(screen.queryByRole('link', { name: /Azure DevOps/ })).toBeNull()
  })
})

describe('the same finding clicked twice', () => {
  // Its own block for the `scrollTo` jsdom does not have. Counting the calls rather
  // than asserting an offset: this file is two lines long, so every offset in it
  // clamps to zero, and the question here is only whether the second click moved
  // anything at all.
  let scrolled: ReturnType<typeof vi.fn>

  beforeEach(() => {
    scrolled = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: scrolled,
    })
  })

  afterEach(() => {
    Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo')
  })

  it('is carried back to the line the second time as well', async () => {
    // The page dispatches a jump, clears it once the list has scrolled, and
    // dispatches the same one again when the reader clicks the occurrence a second
    // time. Everything under here answers that with what it already had — the line
    // is still 2 and still marked — so a scroll guarded on the line would sit still
    // and leave the reader wherever they had read to.
    call.mockResolvedValue(answer(BLOBS))
    // The client is held rather than let `draw` make one, because a re-render that
    // swapped it would remount the panel — and a remounted panel jumps because it is
    // new, which is the one thing this must not be able to pass on.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const show = (jumpTo: number | null) => (
      <QueryClientProvider client={client}>{panel({ jumpTo })}</QueryClientProvider>
    )
    const { rerender } = render(show(2))

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Jumped to line 2.'))
    await waitFor(() => expect(scrolled).toHaveBeenCalled())
    scrolled.mockClear()

    // Cleared, which is the shape `PullRequestDetailView` produces: it drops its own
    // jump as soon as the page has scrolled to the file. Asserted on its own first,
    // or the test below it proves nothing — a virtualizer that scrolled itself on
    // every re-render would satisfy it without the jump doing anything.
    rerender(show(null))
    expect(scrolled).not.toHaveBeenCalled()

    rerender(show(2))

    await waitFor(() => expect(scrolled).toHaveBeenCalled())
    expect(screen.getByRole('status')).toHaveTextContent('Jumped to line 2.')
  })
})
