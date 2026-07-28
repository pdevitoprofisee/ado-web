import { describe, expect, it } from 'vitest'

import { diffFile, formatHunkHeader } from './diff'

// The bar for this module is agreement with `git diff`, so most of what follows
// compares against output git actually produced rather than output that looks
// right. Every `expected` block below was pasted from a real git run and the
// command that produced it is in the comment above it.
//
// The three `Fixture`s are real blob pairs out of this repository's history.
// They are the readable end of a wider check: a scratchpad script ran the same
// comparison over all 81 modified blob pairs in the history, at -U0, -U1, -U3,
// -U5 and -U10, and over 2,000 generated file pairs. Those runs are reported in
// the commit message; these three are here so a regression is visible without
// a git checkout.

/** git's own rendering of a hunk, so a failure diffs as text rather than as objects. */
function render(before: readonly string[], after: readonly string[], context?: number): string[] {
  const out: string[] = []
  for (const hunk of diffFile(before, after, context === undefined ? {} : { context }).hunks) {
    out.push(formatHunkHeader(hunk))
    for (const line of hunk.lines) {
      out.push((line.op === 'add' ? '+' : line.op === 'delete' ? '-' : ' ') + line.text)
    }
  }
  return out
}

interface Fixture {
  before: string[]
  after: string[]
  expected: string[]
}

// git -C . cat-file blob 24c5a638 / aa5472ef  (scripts/start.mjs at 3ba5af9)
// git -C . diff -U3 --no-color 24c5a638 aa5472ef
const START_MJS: Fixture = {
  before: [
    '// Runs the Nitro production build.',
    '//',
    '// Nitro reads its listen address from the environment at runtime, so binding to',
    '// loopback has to happen here rather than in vite.config.ts. Defaulting instead',
    '// of overriding keeps `HOST=0.0.0.0 pnpm start` possible for anyone who',
    '// deliberately wants it — but never by accident.',
    "process.env.HOST ??= '127.0.0.1'",
    "process.env.PORT ??= '3000'",
    '',
    "await import('../.output/server/index.mjs')",
  ],
  after: [
    '// Runs the Nitro production build.',
    '//',
    '// Nitro reads its listen address from the environment at runtime, so binding to',
    '// loopback has to happen here rather than in vite.config.ts. Defaulting instead',
    '// of overriding keeps `HOST=0.0.0.0 pnpm start` possible for anyone who',
    '// deliberately wants it — but never by accident.',
    '// The port matches vite.config.ts so dev and production answer the same URL —',
    '// one bookmark, one habit. Change both together.',
    "process.env.HOST ??= '127.0.0.1'",
    "process.env.PORT ??= '7331'",
    '',
    "await import('../.output/server/index.mjs')",
  ],
  expected: [
    '@@ -4,7 +4,9 @@',
    ' // loopback has to happen here rather than in vite.config.ts. Defaulting instead',
    ' // of overriding keeps `HOST=0.0.0.0 pnpm start` possible for anyone who',
    ' // deliberately wants it — but never by accident.',
    '+// The port matches vite.config.ts so dev and production answer the same URL —',
    '+// one bookmark, one habit. Change both together.',
    " process.env.HOST ??= '127.0.0.1'",
    "-process.env.PORT ??= '3000'",
    "+process.env.PORT ??= '7331'",
    ' ',
    " await import('../.output/server/index.mjs')",
  ],
}

// git -C . cat-file blob 8b25bb54 / 72146f2b  (.gitignore at eadfde7)
// git -C . diff -U3 --no-color 8b25bb54 72146f2b
const GITIGNORE: Fixture = {
  before: [
    'node_modules',
    '.DS_Store',
    'dist',
    'dist-ssr',
    '*.local',
    '.env',
    '.nitro',
    '.tanstack',
    '.wrangler',
    '.output',
    '.vinxi',
    '__unconfig*',
    'todos.json',
  ],
  after: [
    'node_modules',
    '.DS_Store',
    'dist',
    'dist-ssr',
    '*.local',
    '.env',
    '.nitro',
    '.tanstack',
    '.wrangler',
    '.output',
    '.vinxi',
    '__unconfig*',
    'todos.json',
    '.claude/worktrees',
  ],
  expected: [
    '@@ -11,3 +11,4 @@',
    ' .vinxi',
    ' __unconfig*',
    ' todos.json',
    '+.claude/worktrees',
  ],
}

// git -C . cat-file blob 07f5d63a / dcb5f6be  (src/routes/index.tsx at 58608e6)
// git -C . diff -U3 --no-color 07f5d63a dcb5f6be
const INDEX_TSX: Fixture = {
  before: [
    "import { createFileRoute } from '@tanstack/react-router'",
    "import { createServerFn } from '@tanstack/react-start'",
    "import { useQuery } from '@tanstack/react-query'",
    '',
    "import { Button } from '@/components/ui/button'",
    '',
    "// The scaffold's proof-of-life for the half of the app that matters: this body",
    '// is replaced by an RPC stub in the client bundle, so `process` is only ever',
    '// read on the server. Everything that touches a PAT, ADO, or Sonar lives here.',
    "const getServerInfo = createServerFn({ method: 'GET' }).handler(async () => ({",
    '  node: process.version,',
    '  pid: process.pid,',
    '}))',
    '',
    "export const Route = createFileRoute('/')({ component: Home })",
    '',
    'function Home() {',
    '  const server = useQuery({',
    "    queryKey: ['server-info'],",
    '    queryFn: () => getServerInfo(),',
    '  })',
    '',
    '  return (',
    '    <main className="mx-auto flex max-w-xl flex-col items-start gap-4 p-8">',
    '      <h1 className="text-2xl font-semibold tracking-tight">ado-web</h1>',
    '      <p className="text-muted-foreground text-sm">',
    '        Scaffold only. The inbox lands in T-006.',
    '      </p>',
    '',
    '      <p className="text-sm">',
    "        Server function says:{' '}",
    '        <code className="bg-muted rounded px-1.5 py-0.5 text-xs">',
    '          {server.isPending',
    "            ? 'asking…'",
    '            : server.isError',
    '              ? `failed: ${server.error.message}`',
    '              : `node ${server.data.node}, pid ${server.data.pid}`}',
    '        </code>',
    '      </p>',
    '',
    '      <Button onPress={() => server.refetch()} isDisabled={server.isFetching}>',
    '        Ask the server again',
    '      </Button>',
    '    </main>',
    '  )',
    '}',
  ],
  after: [
    "import { createFileRoute } from '@tanstack/react-router'",
    "import { createServerFn } from '@tanstack/react-start'",
    "import { useQuery } from '@tanstack/react-query'",
    '',
    "import { Button } from '@/components/ui/button'",
    "import { Kbd } from '@/components/ui/kbd'",
    '',
    "// The scaffold's proof-of-life for the half of the app that matters: this body",
    '// is replaced by an RPC stub in the client bundle, so `process` is only ever',
    '// read on the server. Everything that touches a PAT, ADO, or Sonar lives here.',
    "const getServerInfo = createServerFn({ method: 'GET' }).handler(async () => ({",
    '  node: process.version,',
    '  pid: process.pid,',
    '}))',
    '',
    "export const Route = createFileRoute('/')({ component: Home })",
    '',
    'function Home() {',
    '  const server = useQuery({',
    "    queryKey: ['server-info'],",
    '    queryFn: () => getServerInfo(),',
    '  })',
    '',
    '  return (',
    '    <main className="mx-auto flex max-w-xl flex-col items-start gap-4 p-8">',
    '      <h1 className="text-2xl font-semibold tracking-tight">ado-web</h1>',
    '      <p className="text-muted-foreground text-sm">',
    "        Scaffold only. The inbox lands in T-006. Press{' '}",
    '        <Kbd>?</Kbd> for keyboard shortcuts.',
    '      </p>',
    '',
    '      <p className="text-sm">',
    "        Server function says:{' '}",
    '        <code className="bg-muted rounded px-1.5 py-0.5 text-xs">',
    '          {server.isPending',
    "            ? 'asking…'",
    '            : server.isError',
    '              ? `failed: ${server.error.message}`',
    '              : `node ${server.data.node}, pid ${server.data.pid}`}',
    '        </code>',
    '      </p>',
    '',
    '      <Button onPress={() => server.refetch()} isDisabled={server.isFetching}>',
    '        Ask the server again',
    '      </Button>',
    '    </main>',
    '  )',
    '}',
  ],
  expected: [
    '@@ -3,6 +3,7 @@',
    " import { useQuery } from '@tanstack/react-query'",
    ' ',
    " import { Button } from '@/components/ui/button'",
    "+import { Kbd } from '@/components/ui/kbd'",
    ' ',
    " // The scaffold's proof-of-life for the half of the app that matters: this body",
    ' // is replaced by an RPC stub in the client bundle, so `process` is only ever',
    '@@ -24,7 +25,8 @@',
    '     <main className="mx-auto flex max-w-xl flex-col items-start gap-4 p-8">',
    '       <h1 className="text-2xl font-semibold tracking-tight">ado-web</h1>',
    '       <p className="text-muted-foreground text-sm">',
    '-        Scaffold only. The inbox lands in T-006.',
    "+        Scaffold only. The inbox lands in T-006. Press{' '}",
    '+        <Kbd>?</Kbd> for keyboard shortcuts.',
    '       </p>',
    ' ',
    '       <p className="text-sm">',
  ],
}

describe('diffFile against real git output', () => {
  const fixtures: [string, Fixture][] = [
    ['scripts/start.mjs', START_MJS],
    ['.gitignore', GITIGNORE],
    ['src/routes/index.tsx', INDEX_TSX],
  ]

  for (const [name, fixture] of fixtures) {
    it(`reproduces git diff -U3 on ${name}`, () => {
      expect(render(fixture.before, fixture.after)).toEqual(fixture.expected)
    })
  }

  // The case that took the longest to find, kept because it is the one where a
  // plausible diff and git's diff disagree. Shrunk from `git show
  // bca6bdb:src/server/inbox.ts`. The blank line is common to both sides and
  // git keeps it as context; xdiff's frequent-line filter is one arithmetic
  // slip away from discarding it and calling all five lines changed.
  it("keeps a blank line as context where git's frequent-line filter keeps it", () => {
    const before = [
      'const byNewest = (a: PullRequestRow, b: PullRequestRow) => b.createdAt.localeCompare(a.createdAt)',
      '',
      'export function partition(',
      '  pullRequests: readonly AdoPullRequest[],',
      '  identity: Identity,',
    ]
    const after = ['', '', '', '']

    // git diff --no-index -U3 --no-color A.txt B.txt
    expect(render(before, after)).toEqual([
      '@@ -1,5 +1,4 @@',
      '-const byNewest = (a: PullRequestRow, b: PullRequestRow) => b.createdAt.localeCompare(a.createdAt)',
      ' ',
      '-export function partition(',
      '-  pullRequests: readonly AdoPullRequest[],',
      '-  identity: Identity,',
      '+',
      '+',
      '+',
    ])
  })

  // The 81-pair history cross-check turned out not to exercise the indent
  // heuristic at all: `diff.indentHeuristic=false` produced identical output on
  // every pair. This pair is one of the generated ones where it does not, so
  // the heuristic branch has at least one test that would fail if it were
  // deleted. With the heuristic off git puts the added line last and the hunk
  // starts at line 2; with it on, git puts it first.
  it('slides an insertion the way the indent heuristic does, not the way plain sliding would', () => {
    const before = ['  return;', '', 'b();', 'b();', 'if (x) {', '  b();']
    const after = ['  return;', '', 'b();', 'b();', 'b();', 'if (x) {', '  b();']

    // git -c diff.indentHeuristic=true diff --no-index -U3 --no-color A.txt B.txt
    expect(render(before, after)).toEqual([
      '@@ -1,5 +1,6 @@',
      '   return;',
      ' ',
      '+b();',
      ' b();',
      ' b();',
      ' if (x) {',
    ])
  })
})

describe('diffFile hunk shape', () => {
  const base = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`)

  /** `base` with line 4 and the line `gap` unchanged lines after it replaced. */
  function twoChanges(gap: number): string[] {
    const after = base.slice()
    after[3] = 'CHANGED A'
    after[4 + gap] = 'CHANGED B'
    return after
  }

  // 2 * context is the boundary: at exactly six unchanged lines between two
  // changes the two hunks would abut without overlapping, and git merges them.
  // git diff --no-index -U3 --no-color A.txt B.txt, gap = 5, 6, 7
  it('merges two changes six unchanged lines apart into one hunk', () => {
    const hunks = diffFile(base, twoChanges(6)).hunks

    expect(hunks).toHaveLength(1)
    expect(formatHunkHeader(hunks[0] as (typeof hunks)[number])).toBe('@@ -1,14 +1,14 @@')
  })

  it('splits two changes seven unchanged lines apart into two hunks', () => {
    const hunks = diffFile(base, twoChanges(7)).hunks

    expect(hunks.map(formatHunkHeader)).toEqual(['@@ -1,7 +1,7 @@', '@@ -9,7 +9,7 @@'])
  })

  it('never prints more than `context` unchanged lines at either end of a hunk', () => {
    for (const context of [0, 1, 3, 5]) {
      for (const hunk of diffFile(base, twoChanges(20), { context }).hunks) {
        const leading = hunk.lines.findIndex((line) => line.op !== 'context')
        let trailing = 0
        for (let i = hunk.lines.length - 1; i >= 0 && hunk.lines[i]?.op === 'context'; i--) trailing++
        expect(leading).toBeLessThanOrEqual(context)
        expect(trailing).toBeLessThanOrEqual(context)
      }
    }
  })

  it('numbers every line the way the header says it does', () => {
    for (const hunk of diffFile(INDEX_TSX.before, INDEX_TSX.after).hunks) {
      let oldLine = hunk.oldStart
      let newLine = hunk.newStart
      for (const line of hunk.lines) {
        if (line.op !== 'add') {
          expect(line.oldLine).toBe(oldLine++)
          expect(INDEX_TSX.before[(line.oldLine as number) - 1]).toBe(line.text)
        } else {
          expect(line.oldLine).toBeNull()
        }
        if (line.op !== 'delete') {
          expect(line.newLine).toBe(newLine++)
          expect(INDEX_TSX.after[(line.newLine as number) - 1]).toBe(line.text)
        } else {
          expect(line.newLine).toBeNull()
        }
      }
      expect(oldLine - hunk.oldStart).toBe(hunk.oldCount)
      expect(newLine - hunk.newStart).toBe(hunk.newCount)
    }
  })

  it('counts exactly the added and removed lines it emitted', () => {
    const diff = diffFile(INDEX_TSX.before, INDEX_TSX.after)
    const lines = diff.hunks.flatMap((hunk) => hunk.lines)

    expect(diff.added).toBe(lines.filter((line) => line.op === 'add').length)
    expect(diff.removed).toBe(lines.filter((line) => line.op === 'delete').length)
    expect(diff.added).toBe(3)
    expect(diff.removed).toBe(1)
  })

  // git spells an empty side as a zero count starting one line early.
  it('writes the zero-count header git writes for a file that was empty', () => {
    expect(render([], ['a', 'b', 'c'])).toEqual(['@@ -0,0 +1,3 @@', '+a', '+b', '+c'])
    expect(render(['a', 'b', 'c'], [])).toEqual(['@@ -1,3 +0,0 @@', '-a', '-b', '-c'])
  })
})

describe('diffFile on identical input', () => {
  it('produces no hunks', () => {
    const lines = ['a', 'b', 'c']

    expect(diffFile(lines, lines.slice())).toEqual({
      hunks: [],
      added: 0,
      removed: 0,
      gaveUp: false,
    })
  })

  // One equality pass is the irreducible cost of knowing the sides match; what
  // must not happen is interning and searching fifty thousand lines to find out.
  // Measured at 0.9 ms on the machine named below.
  it('does not search a file that did not change', () => {
    const lines = Array.from({ length: 50_000 }, (_, i) => `line ${i}`)

    const started = performance.now()
    const diff = diffFile(lines, lines.slice())
    const elapsed = performance.now() - started

    expect(diff.hunks).toEqual([])
    expect(elapsed).toBeLessThan(200)
  })
})

describe('diffFile intra-line edits', () => {
  it('points at the words that changed, not the whole line', () => {
    const diff = diffFile(['const timeout = 30 // seconds'], ['const timeout = 45 // seconds'])
    const [removed, added] = diff.hunks[0]?.lines as [
      (typeof diff.hunks)[number]['lines'][number],
      (typeof diff.hunks)[number]['lines'][number],
    ]

    expect(removed.text.slice(...(removed.edits[0] as [number, number]))).toBe('30')
    expect(added.text.slice(...(added.edits[0] as [number, number]))).toBe('45')
    expect(removed.edits).toHaveLength(1)
    expect(added.edits).toHaveLength(1)
  })

  it('marks nothing when the two lines have no words in common', () => {
    const diff = diffFile(['alpha beta gamma'], ['one two three'])

    for (const line of diff.hunks[0]?.lines ?? []) expect(line.edits).toEqual([])
  })

  // Indentation alone is not a shared word: marking a re-indented line as
  // "everything after the leading spaces changed" says nothing the +/- did not.
  it('marks nothing when the only thing in common is whitespace', () => {
    const diff = diffFile(['  alpha'], ['  omega'])

    for (const line of diff.hunks[0]?.lines ?? []) expect(line.edits).toEqual([])
  })

  it('pairs a run of deletes with the adds opposite them, in order', () => {
    const diff = diffFile(['aaa 1', 'bbb 1'], ['aaa 2', 'bbb 2'])
    const lines = diff.hunks[0]?.lines ?? []

    expect(lines.map((line) => line.op)).toEqual(['delete', 'delete', 'add', 'add'])
    expect(lines[0]?.text.slice(...(lines[0].edits[0] as [number, number]))).toBe('1')
    expect(lines[2]?.text.slice(...(lines[2].edits[0] as [number, number]))).toBe('2')
  })
})

// All timings below were measured on CORPLTR126, an Intel Core Ultra 9 185H
// with 22 logical cores and 63 GiB, running node v24.18.0. The assertions are
// deliberately an order of magnitude looser than the measurement so a busy CI
// machine does not turn a performance note into a red build.
describe('diffFile on pathological input', () => {
  it('diffs 5,000 lines where every line changed, in 27 ms', () => {
    const before = Array.from({ length: 5_000 }, (_, i) => `old line ${i} ${'x'.repeat(40)}`)
    const after = Array.from({ length: 5_000 }, (_, i) => `new line ${i} ${'y'.repeat(40)}`)

    const started = performance.now()
    const diff = diffFile(before, after)
    const elapsed = performance.now() - started

    expect(diff.gaveUp).toBe(false)
    expect(diff.added).toBe(5_000)
    expect(diff.removed).toBe(5_000)
    expect(elapsed).toBeLessThan(3_000)
  })

  // The literal all-changed case above is not actually the hard one: no line
  // occurs on the other side at all, so the frequent-line filter discards every
  // one of them and the search never runs. This is the hard one — the same
  // 5,000 lines on both sides in two different orders, so nothing is
  // discardable and the edit distance is close to 2N. 264 ms, 4.7e7 steps.
  it('diffs 5,000 lines shuffled against themselves, in 264 ms', () => {
    const base = Array.from({ length: 5_000 }, (_, i) => `line ${i}`)
    let seed = 11
    const shuffle = (input: readonly string[]): string[] => {
      const out = input.slice()
      for (let i = out.length - 1; i > 0; i--) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff
        const j = Math.floor((seed / 0x7fffffff) * (i + 1))
        ;[out[i], out[j]] = [out[j] as string, out[i] as string]
      }
      return out
    }

    const started = performance.now()
    const diff = diffFile(shuffle(base), shuffle(base))
    const elapsed = performance.now() - started

    expect(diff.gaveUp).toBe(false)
    expect(elapsed).toBeLessThan(5_000)
  })

  it('diffs a file that is one 10 MB line, in 0.1 ms', () => {
    const before = ['a'.repeat(10 * 1024 * 1024)]
    const after = ['b' + 'a'.repeat(10 * 1024 * 1024 - 1)]

    const started = performance.now()
    const diff = diffFile(before, after)
    const elapsed = performance.now() - started

    expect(diff.gaveUp).toBe(false)
    expect(diff.added).toBe(1)
    expect(diff.removed).toBe(1)
    // No intra-line marking: a 10 MB line has no character range worth pointing
    // at, and the token diff that would find one is quadratic.
    expect(diff.hunks[0]?.lines.every((line) => line.edits.length === 0)).toBe(true)
    expect(elapsed).toBeLessThan(1_000)
  })

  // The budget exists so that a file nobody should be diffing does not lock the
  // tab up. 20,000 shuffled lines is the smallest round number that trips it;
  // it takes 2.5 s to give up, and 15,000 lines still succeeds in 2.1 s.
  it('gives up rather than returning a worse diff', () => {
    const base = Array.from({ length: 20_000 }, (_, i) => `line ${i}`)
    let seed = 13
    const shuffle = (input: readonly string[]): string[] => {
      const out = input.slice()
      for (let i = out.length - 1; i > 0; i--) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff
        const j = Math.floor((seed / 0x7fffffff) * (i + 1))
        ;[out[i], out[j]] = [out[j] as string, out[i] as string]
      }
      return out
    }

    const diff = diffFile(shuffle(base), shuffle(base))

    expect(diff.gaveUp).toBe(true)
    expect(diff.hunks).toEqual([])
  }, 30_000)
})
