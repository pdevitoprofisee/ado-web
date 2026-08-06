import { useState } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'

import { FindBar } from './find-bar'
import { CommandProvider } from '@/commands/command-provider'
import { adoDiffSource, fileBlobsOptions } from '@/lib/blob-query'

import type { FindHit } from '@/lib/diff-find'
import type { FileBlobsResult } from '@/server/blob-fn'
import type { ChangedFile, PullRequestRef } from '@/server/pull-request'

// The box on its own, over a query cache filled by hand. Nothing here fetches:
// what the search can see is exactly what some panel has already put in the
// cache, and the point of most of these is what it does about the rest.

const REF: PullRequestRef = {
  projectId: '11111111-1111-1111-1111-111111111111',
  repositoryId: '22222222-2222-2222-2222-222222222222',
  id: 24698,
}

const file = (path: string, sha: string): ChangedFile => ({
  path,
  changeType: ['edit'],
  originalPath: null,
  objectId: sha.repeat(40),
  originalObjectId: 'z'.repeat(40),
})

const LOG = file('/src/log.ts', 'a')
const APP = file('/src/app.ts', 'b')
const HUGE = file('/src/huge.ts', 'c')

const FILES = [LOG, APP, HUGE] as const

const answer = (path: string, after: readonly string[]): FileBlobsResult => ({
  blobs: {
    path,
    before: { kind: 'text', lines: [], bytes: 0, noFinalNewline: false },
    after: { kind: 'text', lines: after, bytes: 1, noFinalNewline: false },
    renamedOnly: false,
  },
  error: null,
  connected: true,
  rateLimit: null,
})

/** A cache holding the two small files and nothing for the third. */
function loaded() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  client.setQueryData(
    fileBlobsOptions(REF, LOG).queryKey,
    answer(LOG.path, ['const sink = open()', '', 'sink.write(line)']),
  )
  client.setQueryData(
    fileBlobsOptions(REF, APP).queryKey,
    answer(APP.path, ['import { sink } from "./log"']),
  )

  return client
}

/** The bar with its term held above it, the way `ChangedFiles` holds it. */
function Harness({ onGo = () => {} }: { onGo?: (hit: FindHit) => void }) {
  const [term, setTerm] = useState('')

  return (
    <FindBar
      files={FILES}
      diffSource={adoDiffSource(REF)}
      term={term}
      onTerm={setTerm}
      onGo={onGo}
    />
  )
}

function draw(client: QueryClient, onGo?: (hit: FindHit) => void) {
  return render(
    <QueryClientProvider client={client}>
      <CommandProvider>
        <Harness onGo={onGo} />
      </CommandProvider>
    </QueryClientProvider>,
  )
}

const box = () => screen.getByRole('searchbox')

describe('FindBar', () => {
  it('says nothing at all until something has been typed', () => {
    draw(loaded())

    expect(screen.getByRole('status')).toHaveTextContent('')
  })

  it('counts matches across every file whose bytes are in hand', async () => {
    draw(loaded())
    await userEvent.type(box(), 'sink')

    expect(screen.getByRole('status')).toHaveTextContent('3 matching lines')
  })

  it('says how many files it could not look inside', async () => {
    // The blind spot, in words and beside the count: `/src/huge.ts` has never
    // been near the viewport, so nothing fetched it and this cannot see into it.
    draw(loaded())
    await userEvent.type(box(), 'sink')

    expect(screen.getByRole('status')).toHaveTextContent('1 of 3 files not searched')
  })

  it('still names the blind spot when it found nothing', async () => {
    draw(loaded())
    await userEvent.type(box(), 'nowhere')

    expect(screen.getByRole('status')).toHaveTextContent(
      'No matching lines · 1 of 3 files not searched',
    )
  })

  it('does not fetch the files it cannot see', async () => {
    const client = loaded()
    const fetches = vi.spyOn(client, 'fetchQuery')
    draw(client)
    await userEvent.type(box(), 'sink')

    expect(fetches).not.toHaveBeenCalled()
    expect(client.getQueryState(fileBlobsOptions(REF, HUGE).queryKey)).toBeUndefined()
  })

  it('steps through the matches in reading order, and wraps', async () => {
    const went: FindHit[] = []
    draw(loaded(), (hit) => went.push(hit))
    await userEvent.type(box(), 'sink')

    const next = screen.getByRole('button', { name: 'Next match' })
    await userEvent.click(next)
    await userEvent.click(next)
    await userEvent.click(next)
    await userEvent.click(next)

    expect(went).toEqual([
      { path: '/src/log.ts', line: 1 },
      { path: '/src/log.ts', line: 3 },
      { path: '/src/app.ts', line: 1 },
      { path: '/src/log.ts', line: 1 },
    ])
  })

  it('starts at the last match when the first step is backwards', async () => {
    const went: FindHit[] = []
    draw(loaded(), (hit) => went.push(hit))
    await userEvent.type(box(), 'sink')
    await userEvent.click(screen.getByRole('button', { name: 'Previous match' }))

    expect(went).toEqual([{ path: '/src/app.ts', line: 1 }])
  })

  it('shows where in the run the reader is standing, once they have moved', async () => {
    draw(loaded())
    await userEvent.type(box(), 'sink')

    expect(screen.getByRole('status')).not.toHaveTextContent('1 of 3 matches')

    await userEvent.click(screen.getByRole('button', { name: 'Next match' }))

    expect(screen.getByRole('status')).toHaveTextContent('1 of 3')
  })

  it('steps on Enter, and backwards on Shift+Enter', async () => {
    const went: FindHit[] = []
    draw(loaded(), (hit) => went.push(hit))
    await userEvent.type(box(), 'sink{Enter}{Shift>}{Enter}{/Shift}')

    expect(went).toEqual([
      { path: '/src/log.ts', line: 1 },
      { path: '/src/app.ts', line: 1 },
    ])
  })

  it('does not move for a term nothing matches', async () => {
    const went: FindHit[] = []
    draw(loaded(), (hit) => went.push(hit))
    await userEvent.type(box(), 'nowhere{Enter}')

    expect(went).toEqual([])
    expect(screen.getByRole('button', { name: 'Next match' })).toBeDisabled()
  })

  it('picks up a file whose bytes arrive while the box is open', async () => {
    // A panel scrolled into view mid-search. The count has to move on its own —
    // waiting for an unrelated render is how a search quietly stays wrong.
    const client = loaded()
    draw(client)
    await userEvent.type(box(), 'sink')

    expect(screen.getByRole('status')).toHaveTextContent('3 matching lines')

    client.setQueryData(
      fileBlobsOptions(REF, HUGE).queryKey,
      answer(HUGE.path, ['sink()', 'sink()']),
    )

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('5 matching lines · 3 files searched'),
    )
  })

  it('takes the keyboard on the key it declares', async () => {
    draw(loaded())
    expect(box()).not.toHaveFocus()

    await userEvent.keyboard('/')

    expect(box()).toHaveFocus()
    // The key that focused the box must not also land in it.
    expect(box()).toHaveValue('')
  })

  it('clears on Escape, and leaves on the second press', async () => {
    draw(loaded())
    await userEvent.type(box(), 'sink')

    await userEvent.keyboard('{Escape}')
    expect(box()).toHaveValue('')
    expect(box()).toHaveFocus()

    await userEvent.keyboard('{Escape}')
    expect(box()).not.toHaveFocus()
  })
})
