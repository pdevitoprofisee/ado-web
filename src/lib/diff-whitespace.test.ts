// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { diffFile, formatHunkHeader } from './diff'

// `-w` against real `git diff -w`, on real files, run here rather than pasted.
//
// The rest of the differ is checked with fixtures pasted out of a git run, and
// that works because the answers are short enough to read. This flag's answers
// are not: the whole point of `-w` is a re-indented file where every line moved,
// and a fixture for one of those is nine hundred lines that nobody will ever
// read closely enough to notice being wrong. Note 14 is about exactly that —
// a fixture agrees with whatever the person writing it already believed, which
// is the belief at risk — so git is the oracle and it is asked at test time.
//
// The corpus is this repository's own source, re-indented and re-tabbed the way
// a formatter run would. Both flags are checked on every pair: without `-w` as
// well, because a bug that turns every line into context passes an `-w`-only
// check on a whitespace-only edit and fails nothing.
//
// The cost is about forty process starts, a second or two. `local-git.test.ts`
// pays the same price for the same reason.

let tmp: string

beforeAll(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ado-web-diff-w-')))
})

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true })
})

/** Our hunks in git's own spelling, so a failure diffs as text rather than as objects. */
function render(
  before: readonly string[],
  after: readonly string[],
  ignoreWhitespace: boolean,
): string[] {
  const out: string[] = []
  for (const hunk of diffFile(before, after, { ignoreWhitespace }).hunks) {
    out.push(formatHunkHeader(hunk))
    for (const line of hunk.lines) {
      out.push((line.op === 'add' ? '+' : line.op === 'delete' ? '-' : ' ') + line.text)
    }
  }
  return out
}

/**
 * The same thing from git.
 *
 * `core.autocrlf` is pinned off per invocation for note 17's reason: it is on
 * globally on the machine this was written on, and a corpus written with `\n`
 * would otherwise be read back through a filter on one machine and not another.
 * `--no-index` exits 1 when the files differ, which `execFileSync` raises, so
 * the output is read off the error as often as off the return.
 */
function gitDiff(
  before: readonly string[],
  after: readonly string[],
  ignoreWhitespace: boolean,
): string[] {
  const a = join(tmp, 'a.txt')
  const b = join(tmp, 'b.txt')
  writeFileSync(a, before.length === 0 ? '' : `${before.join('\n')}\n`)
  writeFileSync(b, after.length === 0 ? '' : `${after.join('\n')}\n`)

  const args = ['-c', 'core.autocrlf=false', 'diff', '--no-index', '--no-color', '-U3']
  if (ignoreWhitespace) args.push('-w')
  args.push('--', a, b)

  let stdout: string
  try {
    stdout = execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    const failure = error as { status?: number; stdout?: string }
    // 1 is "they differ", which is the ordinary case here. Anything else is git
    // failing, and swallowing it would turn a broken invocation into a pass.
    if (failure.status !== 1 || failure.stdout === undefined) throw error
    stdout = failure.stdout
  }

  const lines = stdout.split('\n')
  const first = lines.findIndex((line) => line.startsWith('@@'))
  if (first === -1) return []
  return lines
    .slice(first)
    .filter((line) => line !== '' && !line.startsWith('\\'))
    .map((line) => (line.startsWith('@@') ? line.slice(0, line.indexOf('@@', 2) + 2) : line))
}

/** The committed bytes, not the checked-out ones. See note 17. */
function sourceLines(path: string): string[] {
  return readFileSync(join(process.cwd(), path), 'utf8').replace(/\r\n/g, '\n').split('\n')
}

/** Leading indentation only, in units of two, doubled — a formatter changing its mind. */
function reindent(lines: readonly string[]): string[] {
  return lines.map((line) => {
    const indent = line.length - line.trimStart().length
    return ' '.repeat(indent * 2) + line.slice(indent)
  })
}

/** Leading spaces to tabs, two to one. The other formatter argument. */
function tabbed(lines: readonly string[]): string[] {
  return lines.map((line) => {
    const indent = line.length - line.trimStart().length
    return '\t'.repeat(Math.floor(indent / 2)) + ' '.repeat(indent % 2) + line.slice(indent)
  })
}

/** Two spaces on the end of every line that has anything on it. An editor without a trim-on-save. */
function trailing(lines: readonly string[]): string[] {
  return lines.map((line) => (line === '' ? '   ' : `${line}  `))
}

/**
 * A re-indent with three real edits buried in it, which is the case the toggle
 * exists for: the reader wants the three and the formatter gave them everything.
 * Placed by fraction so a fifty-line file gets edited as well as a nine-hundred.
 */
function reindentAndEdit(lines: readonly string[]): string[] {
  const out = reindent(lines)
  const at = (fraction: number): number => Math.floor(out.length * fraction)
  out[at(0.2)] = `${out[at(0.2)] as string} // touched`
  out.splice(at(0.5), 1)
  out.splice(at(0.7), 0, 'const inserted = true')
  return out
}

const CORPUS = [
  'src/lib/diff.ts',
  'src/lib/diff-rows.ts',
  'src/components/diff/changed-file.tsx',
  'src/components/diff/layout-toggle.tsx',
]

const MUTATIONS: [string, (lines: readonly string[]) => string[]][] = [
  ['re-indented', reindent],
  ['tabbed', tabbed],
  ['trailing whitespace', trailing],
  ['re-indented with edits', reindentAndEdit],
  ['re-tabbed with edits', (lines) => tabbed(reindentAndEdit(lines))],
]

describe('diffFile with ignoreWhitespace, against real git diff -w', () => {
  for (const path of CORPUS) {
    for (const [name, mutate] of MUTATIONS) {
      it(`agrees with git on ${path} ${name}`, () => {
        const before = sourceLines(path)
        const after = mutate(before)

        const plain = gitDiff(before, after, false)
        const ignored = gitDiff(before, after, true)
        // The oracle is asked something first. Two empty arrays compare equal,
        // and a `gitDiff` that silently returned nothing would make every
        // assertion below pass while measuring nothing at all.
        expect(plain.length).toBeGreaterThan(0)
        expect(ignored).not.toEqual(plain)

        expect(render(before, after, true)).toEqual(ignored)
        // The control. Without it, a `squeezed` key applied down both paths
        // would pass every `-w` assertion and quietly break the ordinary diff.
        expect(render(before, after, false)).toEqual(plain)
      })
    }
  }

  // The re-indent is not symmetric — `-w` context prints one side's bytes and
  // the sides swap — so the reverse of a pair is a different question, not the
  // same one backwards.
  it('agrees with git when the formatter run is undone instead of applied', () => {
    const after = sourceLines('src/lib/diff-rows.ts')
    const before = reindentAndEdit(after)

    const ignored = gitDiff(before, after, true)
    expect(ignored.length).toBeGreaterThan(0)
    expect(render(before, after, true)).toEqual(ignored)
    expect(render(before, after, false)).toEqual(gitDiff(before, after, false))
  })
})
