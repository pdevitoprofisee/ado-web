// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  loadDirtyCount,
  loadLocalBlobs,
  loadLocalChanges,
  loadRemoteRefs,
  openRepository,
  scanRepositories,
} from './local-git'

import type { LocalChangedFile } from '../lib/local-git-contract'

// Real repositories, built by real `git`, under a real temporary directory.
//
// **Hand-authored `--raw` and `--batch` strings are not the input.** Every
// interesting thing this layer does is a claim about what git actually prints —
// that `-z` un-quotes a path with a space in it, that `--abbrev=40` is needed
// because the default is seven characters, that a mode-only change arrives with
// two identical shas, that `cat-file --batch` frames a body by a size that has
// to be read past even when the body is refused. A fixture that feeds the
// parser a string this file made up tests the parser against this file's
// beliefs, and every one of those beliefs is the thing at risk.
//
// The cost is about a second of process starts, which is why the fixtures are
// built once in `beforeAll` and shared. Each of them sets `core.autocrlf` and
// `core.fileMode` **explicitly**, because both are set globally on the machine
// this was written on and a fixture that inherits them passes or fails
// depending on whose machine ran it.
//
// `execFileSync` here rather than `local-git.ts`'s own runner: a test that
// builds its fixtures with the code under test cannot fail in the interesting
// way. This is the only other place in the app that spawns git, and it writes.

let tmp: string
let root: string
let other: string

const run = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

function init(path: string, branch = 'main'): string {
  mkdirSync(path, { recursive: true })
  run(path, ['init', '-b', branch])
  run(path, ['config', 'user.email', 'fixture@example.com'])
  run(path, ['config', 'user.name', 'Fixture'])
  // A machine with signing turned on globally would otherwise hang on a
  // passphrase prompt, in a test suite with nobody to type it.
  run(path, ['config', 'commit.gpgsign', 'false'])
  run(path, ['config', 'core.autocrlf', 'false'])
  run(path, ['config', 'core.fileMode', 'false'])

  return path
}

const put = (dir: string, name: string, content: string | Buffer): void => {
  writeFileSync(join(dir, name), content)
}

const commit = (dir: string, message: string): void => {
  run(dir, ['add', '-A'])
  run(dir, ['commit', '-m', message])
}

/** What a clone would have. `update-ref` writes the remote-tracking ref without a remote. */
function publish(dir: string): void {
  const sha = run(dir, ['rev-parse', 'HEAD']).trim()
  run(dir, ['update-ref', 'refs/remotes/origin/main', sha])
  run(dir, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])
}

const lines = (count: number, prefix: string): string =>
  `${Array.from({ length: count }, (_, at) => `${prefix} line ${at}`).join('\n')}\n`

/** Over `MAX_BLOB_BYTES`, and deliberately not binary — the size is the reason it is refused. */
const HUGE = `${'x'.repeat(1_200_000)}\n`

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03])

beforeAll(() => {
  // `realpath` because `mkdtemp` can hand back an 8.3 short path on Windows and
  // a `/var` symlink on macOS, while git answers with the real one — and the
  // repository test is a path *equality*.
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ado-web-git-')))
  root = join(tmp, 'root')
  other = join(tmp, 'other')
  mkdirSync(root, { recursive: true })
  mkdirSync(other, { recursive: true })
  mkdirSync(join(tmp, 'empty'), { recursive: true })

  // Not repositories, and both live where a scan will look at them.
  mkdirSync(join(root, 'not-a-repo'), { recursive: true })
  mkdirSync(join(root, 'node_modules'), { recursive: true })

  const fixture = init(join(root, 'fixture'))
  mkdirSync(join(fixture, 'nested'), { recursive: true })
  put(fixture, 'kept.txt', 'same\n')
  put(fixture, 'edited.txt', 'one\ntwo\nthree\n')
  put(fixture, 'deleted.txt', 'gone\n')
  put(fixture, 'renamed.txt', lines(20, 'renamed'))
  put(fixture, 'moved.txt', lines(20, 'moved'))
  put(fixture, 'mode.txt', '#!/bin/sh\necho hi\n')
  put(fixture, 'binary.bin', PNG)
  put(fixture, 'shrunk.txt', HUGE)
  put(fixture, join('nested', 'deep.txt'), 'deep\n')
  put(fixture, 'a name with spaces.txt', 'quoted\n')
  commit(fixture, 'base')
  publish(fixture)

  run(fixture, ['checkout', '-b', 'feature'])
  put(fixture, 'edited.txt', 'one\nTWO\nthree\n')
  rmSync(join(fixture, 'deleted.txt'))
  run(fixture, ['mv', 'renamed.txt', 'renamed-new.txt'])
  run(fixture, ['mv', 'moved.txt', 'moved-new.txt'])
  put(fixture, 'moved-new.txt', lines(20, 'moved').replace('moved line 3', 'moved line THREE'))
  put(fixture, 'added.txt', 'new\n')
  put(fixture, 'crlf.txt', 'alpha\r\nbeta\r\n')
  put(fixture, 'nonl.txt', 'no newline at the end')
  put(fixture, 'empty.txt', '')
  put(fixture, 'big.txt', HUGE)
  put(fixture, 'shrunk.txt', 'small\n')
  put(fixture, 'binary.bin', Buffer.concat([PNG, Buffer.from([0x00, 0xff, 0x00])]))
  put(fixture, 'a name with spaces.txt', 'quoted, and changed\n')
  commit(fixture, 'the awkward set')
  // `add -A` would re-stage the file at its filesystem mode, and `core.fileMode`
  // is off — `--chmod` is the only way to record 100755 on Windows at all.
  run(fixture, ['update-index', '--chmod=+x', 'mode.txt'])
  run(fixture, ['commit', '-m', 'make it executable'])

  const noremote = init(join(root, 'noremote'))
  put(noremote, 'only.txt', 'alone\n')
  commit(noremote, 'only')

  init(join(root, 'unborn'))

  // A HEAD that is a commit and not a branch, which the diff has to refuse in
  // words rather than resolve to something plausible.
  const detached = init(join(root, 'detached'))
  put(detached, 'only.txt', 'alone\n')
  commit(detached, 'only')
  run(detached, ['checkout', '--detach'])

  const orphan = init(join(root, 'orphan'), 'work')
  put(orphan, 'only.txt', 'alone\n')
  commit(orphan, 'only')

  const renames = init(join(root, 'renames'))
  run(renames, ['config', 'diff.renameLimit', '1'])
  for (const at of [1, 2, 3]) put(renames, `file-${at}.txt`, lines(30, `file ${at}`))
  commit(renames, 'base')
  publish(renames)
  run(renames, ['checkout', '-b', 'feature'])
  for (const at of [1, 2, 3]) {
    run(renames, ['mv', `file-${at}.txt`, `moved-${at}.txt`])
    put(renames, `moved-${at}.txt`, lines(30, `file ${at}`).replace('line 0', 'line zero'))
  }
  commit(renames, 'move everything')

  // The same basename under a second root.
  const twin = init(join(other, 'fixture'))
  put(twin, 'only.txt', 'alone\n')
  commit(twin, 'only')

  process.env.ADO_WEB_REPOS_ROOT = root
  // Roughly 90 synchronous `git` processes, which is about 11 seconds on Windows
  // on its own and more when the other 65 test files are running beside it. The
  // default 10 second hook budget fails the whole file with a timeout, so the
  // budget is stated here rather than raised for every hook in the suite.
}, 120_000)

afterAll(() => {
  delete process.env.ADO_WEB_REPOS_ROOT
  rmSync(tmp, { recursive: true, force: true })
})

const byPath = (files: readonly LocalChangedFile[]): Map<string, LocalChangedFile> =>
  new Map(files.map((file) => [file.path, file]))

describe('discovery', () => {
  it('lists the repositories one level under the root and nothing else', async () => {
    const scan = await scanRepositories()

    expect(scan.repositories.map((entry) => entry.slug).sort()).toEqual([
      'detached',
      'fixture',
      'noremote',
      'orphan',
      'renames',
      'unborn',
    ])
    expect(scan.roots).toEqual([{ path: root, configured: true, exists: true }])
  })

  it('does not mistake a directory inside a repository for a repository', async () => {
    // The trap: `rev-parse --show-toplevel` answers from anywhere inside a
    // repository, so `nested` would report `fixture`'s toplevel and be listed.
    process.env.ADO_WEB_REPOS_ROOT = join(root, 'fixture')
    try {
      const scan = await scanRepositories()

      expect(scan.roots[0].exists).toBe(true)
      expect(scan.repositories).toEqual([])
    } finally {
      process.env.ADO_WEB_REPOS_ROOT = root
    }
  })

  it('tells a root that is not there from a root with nothing in it', async () => {
    process.env.ADO_WEB_REPOS_ROOT = join(tmp, 'nowhere')
    const missing = await scanRepositories()

    process.env.ADO_WEB_REPOS_ROOT = join(tmp, 'empty')
    const empty = await scanRepositories()
    process.env.ADO_WEB_REPOS_ROOT = root

    expect(missing.roots[0]).toEqual({ path: join(tmp, 'nowhere'), configured: true, exists: false })
    expect(missing.repositories).toEqual([])
    expect(empty.roots[0]).toEqual({ path: join(tmp, 'empty'), configured: true, exists: true })
    expect(empty.repositories).toEqual([])
  })

  it('reads several roots, and lists a repeated name from both without addressing either', async () => {
    process.env.ADO_WEB_REPOS_ROOT = `${root}${delimiter}${other}`
    try {
      const scan = await scanRepositories()
      const twins = scan.repositories.filter((entry) => entry.slug === 'fixture')

      expect(scan.roots.map((entry) => entry.path)).toEqual([root, other])
      expect(twins).toHaveLength(2)
      expect(twins.map((entry) => entry.path).sort()).toEqual(
        [join(root, 'fixture'), join(other, 'fixture')].sort(),
      )
      for (const twin of twins) {
        expect(twin.kind === 'repository' && twin.unaddressable).toContain('Two repositories')
      }

      await expect(openRepository('fixture')).rejects.toThrow(/Two repositories/)
    } finally {
      process.env.ADO_WEB_REPOS_ROOT = root
    }
  })

  it('refuses a slug that names nothing, rather than guessing', async () => {
    await expect(openRepository('../../etc')).rejects.toThrow(/No repository named/)
    await expect(openRepository('not-a-repo')).rejects.toThrow(/No repository named/)
  })
})

describe('head and the target ladder', () => {
  it('resolves through origin/HEAD and names the branch it points at', async () => {
    const { repository } = await openRepository('fixture')

    expect(repository.head).toEqual({
      kind: 'branch',
      name: 'feature',
      commit: expect.stringMatching(/^[0-9a-f]{40}$/),
    })
    expect(repository.target).toEqual({
      kind: 'resolved',
      rung: 'origin-head',
      ref: {
        name: 'origin/main',
        fullName: 'refs/remotes/origin/main',
        commit: expect.stringMatching(/^[0-9a-f]{40}$/),
      },
      baseCommittedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    })
  })

  it('falls back to a local branch when there is no remote at all', async () => {
    const { repository } = await openRepository('noremote')

    expect(repository.target).toMatchObject({
      kind: 'resolved',
      rung: 'local-branch',
      ref: { name: 'main', fullName: 'refs/heads/main' },
    })
  })

  it('reads an unborn HEAD as a name with no commit, and says what it tried', async () => {
    const { repository, refs } = await openRepository('unborn')

    expect(repository.head).toEqual({ kind: 'unborn', name: 'main' })
    expect(refs.local).toEqual([])
    expect(repository.target).toEqual({
      kind: 'unresolved',
      tried: ['origin/HEAD', 'origin/main', 'origin/master', 'main', 'master'],
    })
  })

  it('reads local refs eagerly and leaves the remotes for later', async () => {
    const { refs } = await openRepository('fixture')

    expect(refs.local.map((ref) => ref.name).sort()).toEqual(['feature', 'main'])
    expect(refs.remote).toBeNull()
  })

  it('reads the remote refs on demand, without the HEAD alias', async () => {
    const remote = await loadRemoteRefs('fixture')

    expect(remote).toEqual([
      {
        name: 'origin/main',
        fullName: 'refs/remotes/origin/main',
        commit: expect.stringMatching(/^[0-9a-f]{40}$/),
      },
    ])
  })
})

describe('the change set', () => {
  let files: Map<string, LocalChangedFile>
  let changes: Awaited<ReturnType<typeof loadLocalChanges>>

  beforeAll(async () => {
    changes = await loadLocalChanges('fixture', 'feature', null)
    files = byPath(changes.files)
  })

  it('counts the commits the branch is ahead by, and is not truncated', () => {
    expect(changes.commits).toBe(2)
    expect(changes.truncated).toBe(false)
    expect(changes.renameDetectionSkipped).toBe(false)
  })

  it('has a word for every kind of change git reports', () => {
    expect(files.get('added.txt')?.changeType).toEqual(['add'])
    expect(files.get('deleted.txt')?.changeType).toEqual(['delete'])
    expect(files.get('edited.txt')?.changeType).toEqual(['edit'])
    expect(files.get('mode.txt')?.changeType).toEqual(['edit'])
    expect(files.get('renamed-new.txt')?.changeType).toEqual(['rename'])
    expect(files.get('moved-new.txt')?.changeType).toEqual(['rename', 'edit'])
    expect(files.has('kept.txt')).toBe(false)
  })

  it('carries the path a rename came from, and full object ids on both sides', () => {
    const renamed = files.get('renamed-new.txt')
    const added = files.get('added.txt')

    expect(renamed?.originalPath).toBe('renamed.txt')
    // A rename that changed nothing is the same object on both sides.
    expect(renamed?.objectId).toBe(renamed?.originalObjectId)
    // Seven characters is git's default, and a prefix is not a content address.
    expect(added?.objectId).toMatch(/^[0-9a-f]{40}$/)
    expect(added?.originalObjectId).toBeNull()
    expect(added?.originalPath).toBeNull()
    expect(files.get('deleted.txt')?.objectId).toBeNull()
  })

  it('reads a path with a space in it, which git would otherwise quote', () => {
    expect(files.get('a name with spaces.txt')?.changeType).toEqual(['edit'])
  })

  it('carries both modes, so a mode-only change can be told from an edit', () => {
    expect(files.get('mode.txt')).toMatchObject({ beforeMode: '100644', afterMode: '100755' })
    expect(files.get('added.txt')).toMatchObject({ beforeMode: null, afterMode: '100644' })
    expect(files.get('deleted.txt')).toMatchObject({ beforeMode: '100644', afterMode: null })
  })

  it('names both refs it diffed and which rung found the base', () => {
    // The page cannot reconstruct any of this from a URL that named neither, and
    // it states both in the header regardless of which one the URL pinned.
    expect(changes.diffed).toEqual({
      branch: {
        name: 'feature',
        fullName: 'refs/heads/feature',
        commit: expect.stringMatching(/^[0-9a-f]{40}$/),
      },
      base: {
        name: 'origin/main',
        fullName: 'refs/remotes/origin/main',
        commit: expect.stringMatching(/^[0-9a-f]{40}$/),
      },
      rung: 'origin-head',
      baseCommittedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    })
  })

  it('takes the branch off HEAD when the URL named none', async () => {
    const current = await loadLocalChanges('fixture', null, null)

    expect(current.diffed.branch.name).toBe('feature')
    expect(current.files.map((file) => file.path).sort()).toEqual(
      changes.files.map((file) => file.path).sort(),
    )
  })

  it('diffs against a pinned target, and claims no rung for it', async () => {
    const pinned = await loadLocalChanges('fixture', 'feature', 'main')

    // `main` is where the branch left, so the merge base is the same commit and
    // the file list is unchanged — what moves is who says it was chosen.
    expect(pinned.diffed.base.fullName).toBe('refs/heads/main')
    expect(pinned.diffed.rung).toBeNull()
    expect(pinned.diffed.baseCommittedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('finds nothing between a branch and itself', async () => {
    const same = await loadLocalChanges('fixture', 'main', null)

    expect(same.files).toEqual([])
    expect(same.commits).toBe(0)
    // And the page can say why: the branch *is* the target, which no file count
    // can distinguish from a branch that changed nothing.
    expect(same.diffed.branch.commit).toBe(same.diffed.base.commit)
  })

  it('says so when git gives up on rename detection', async () => {
    const skipped = await loadLocalChanges('renames', 'feature', null)

    expect(skipped.renameDetectionSkipped).toBe(true)
    expect(skipped.files.map((file) => file.changeType.join('+')).sort()).toEqual([
      'add',
      'add',
      'add',
      'delete',
      'delete',
      'delete',
    ])
  })

  it('fails closed on a branch that is not in the repository', async () => {
    await expect(loadLocalChanges('fixture', 'nope', null)).rejects.toThrow(
      /No branch named `nope`/,
    )
  })

  it('fails closed on a pinned target that is not in the repository', async () => {
    // A target deleted in the terminal after the page loaded. Falling back to the
    // ladder would show the diff of something other than what the URL asked for.
    await expect(loadLocalChanges('fixture', 'feature', 'gone')).rejects.toThrow(
      /No branch named `gone`/,
    )
  })

  it('fails with words when there is nothing to diff against', async () => {
    await expect(loadLocalChanges('orphan', 'work', null)).rejects.toThrow(
      /tried origin\/HEAD, origin\/main, origin\/master, main, master/,
    )
  })

  it('refuses a HEAD that is not a branch, and says how to name one', async () => {
    await expect(loadLocalChanges('detached', null, null)).rejects.toThrow(
      /HEAD is detached.*\?branch=/s,
    )
    await expect(loadLocalChanges('unborn', null, null)).rejects.toThrow(
      /`unborn` has no commits yet/,
    )
  })
})

describe('blobs', () => {
  let files: Map<string, LocalChangedFile>

  beforeAll(async () => {
    files = byPath((await loadLocalChanges('fixture', 'feature', null)).files)
  })

  const blobs = async (path: string) => loadLocalBlobs('fixture', files.get(path)!)

  it('reads both sides of an edit in one invocation', async () => {
    const both = await blobs('edited.txt')

    expect(both.before).toEqual({
      kind: 'text',
      lines: ['one', 'two', 'three'],
      bytes: 14,
      noFinalNewline: false,
    })
    expect(both.after).toMatchObject({ kind: 'text', lines: ['one', 'TWO', 'three'] })
    expect(both.note).toBeNull()
    expect(both.renamedOnly).toBe(false)
  })

  it('leaves the missing side of an add and a delete absent', async () => {
    const added = await blobs('added.txt')
    const deleted = await blobs('deleted.txt')

    expect(added.before).toEqual({ kind: 'absent' })
    expect(added.after).toMatchObject({ kind: 'text', lines: ['new'] })
    expect(deleted.before).toMatchObject({ kind: 'text', lines: ['gone'] })
    expect(deleted.after).toEqual({ kind: 'absent' })
  })

  it('does not fetch a rename that changed nothing', async () => {
    const renamed = await blobs('renamed-new.txt')

    expect(renamed).toEqual({
      path: 'renamed-new.txt',
      before: { kind: 'absent' },
      after: { kind: 'absent' },
      renamedOnly: true,
      note: null,
    })
  })

  it('says what changed when only the mode did', async () => {
    const flipped = await blobs('mode.txt')

    expect(flipped.note).toBe('Mode changed, 100644 → 100755.')
    expect(flipped.renamedOnly).toBe(false)
    expect(flipped.before).toEqual({ kind: 'absent' })
  })

  it('keeps CRLF, a missing final newline and an empty file exactly as they are', async () => {
    const crlf = await blobs('crlf.txt')
    const nonl = await blobs('nonl.txt')
    const empty = await blobs('empty.txt')

    expect(crlf.after).toMatchObject({ lines: ['alpha\r', 'beta\r'], noFinalNewline: false })
    expect(nonl.after).toMatchObject({ lines: ['no newline at the end'], noFinalNewline: true })
    expect(empty.after).toEqual({ kind: 'text', lines: [], bytes: 0, noFinalNewline: false })
  })

  it('calls a file with a NUL in it binary, on both sides', async () => {
    const binary = await blobs('binary.bin')

    expect(binary.before).toEqual({ kind: 'binary', bytes: 12 })
    expect(binary.after).toEqual({ kind: 'binary', bytes: 15 })
  })

  it('refuses a blob over the limit by its declared size', async () => {
    const big = await blobs('big.txt')

    expect(big.after).toEqual({ kind: 'too-large', bytes: HUGE.length })
  })

  it('reads the record after a refused one, which means the refused bytes were drained', async () => {
    // The trap: `--batch` frames a body by a declared size and has no delimiter
    // to resynchronise on. Refusing the content without reading past the bytes
    // leaves 1.2 MB of `x` where the next header should be.
    const shrunk = await blobs('shrunk.txt')

    expect(shrunk.before).toEqual({ kind: 'too-large', bytes: HUGE.length })
    expect(shrunk.after).toMatchObject({ kind: 'text', lines: ['small'] })
  })

  it('states a submodule rather than asking git for a commit it does not have', async () => {
    // Hand-written because it is a *request*, not git's output: a real gitlink
    // needs a second repository and `protocol.file.allow`, to exercise four
    // lines that never reach git at all.
    const moved = await loadLocalBlobs('fixture', {
      path: 'vendor/lib',
      originalPath: null,
      objectId: 'def5678def5678def5678def5678def5678def56',
      originalObjectId: 'abc1234abc1234abc1234abc1234abc1234abc12',
      beforeMode: '160000',
      afterMode: '160000',
    })

    expect(moved.note).toBe('Submodule, moved from `abc1234` to `def5678`.')
    expect(moved.before).toEqual({ kind: 'absent' })
  })

  it('will not write anything that is not an object id to cat-file', async () => {
    await expect(
      loadLocalBlobs('fixture', {
        path: 'edited.txt',
        originalPath: null,
        objectId: '--batch-all-objects',
        originalObjectId: null,
        beforeMode: '100644',
        afterMode: '100644',
      }),
    ).rejects.toThrow(/is not an object id/)
  })
})

describe('the working tree', () => {
  it('counts what is uncommitted, tracked or not', async () => {
    const clean = await loadDirtyCount('noremote')

    put(join(root, 'noremote'), 'only.txt', 'edited in the working tree\n')
    put(join(root, 'noremote'), 'untracked.txt', 'new\n')

    expect(clean).toBe(0)
    expect(await loadDirtyCount('noremote')).toBe(2)
  })
})
