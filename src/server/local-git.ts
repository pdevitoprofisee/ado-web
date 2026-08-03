import { spawn } from 'node:child_process'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'

import { MAX_BLOB_BYTES, readBlob } from './blob'
import { FILE_LIMIT } from './pull-request'

import type { BlobSide } from '../lib/diff-contract'
import type {
  DiffPair,
  GitRef,
  LocalChangeSet,
  LocalChangedFile,
  LocalFileBlobs,
  LocalRepository,
  RepoHead,
  RepositoryDetail,
  RepositoryEntry,
  RepositoryScan,
  ScannedRoot,
  TargetResolution,
  TargetRung,
} from '../lib/local-git-contract'

// Server-only. Every `git` this app runs, and the only file in it that may
// import `node:child_process`. The shapes it answers in are
// `src/lib/local-git-contract.ts`, frozen before this file existed; the
// measurements the decisions lean on are `docs/research/local-git.md`.
//
// **Read-only, by construction rather than by care.** Nothing below fetches,
// checks out, writes a ref or touches the index. `--no-optional-locks` is on
// every invocation because `git status` writes `.git/index` without it, and
// this app is expected to be looking at a repository that somebody is working
// in from a terminal at the same time.
//
// **Nothing from a request reaches `git`'s argv.** That is a whitelist and not
// a predicate — no escaping, no sanitising, no clever regex over user input:
//
//   - A **slug** is compared for equality against the directory names the
//     filesystem just handed back, so the only strings that survive are ones
//     that name a real child of a configured root. No path is expressible.
//   - A **ref** is looked up in the set `for-each-ref` just enumerated for that
//     repository, and what goes into argv is the `refs/…` full name git itself
//     printed. A name that is not in the set fails closed with words rather
//     than falling back to the default: a silent fallback shows the diff of
//     something other than what was asked for, which is worse than an error.
//   - An **object id** is 40 hex digits or it is not written to `cat-file`'s
//     stdin.
//
// The belt to those braces is in `gitArgs`: a value that begins with `-` is
// refused outright, and every value is placed after `--end-of-options` so git
// cannot read one as a flag even if one ever got that far.
//
// `simple-git` is deliberately not a dependency. The map's constraint on it
// (`>=3.36.0`, and request data must never reach its options array) is
// satisfied most cheaply by not having it.

/**
 * Long enough that a cold `status` on a 13,807-file repository is not a
 * failure, short enough that a hung invocation is not a hung page.
 *
 * Nothing here should ever approach it: the slowest measured invocation is
 * `status --porcelain=v2` at 216 ms warm. `GIT_TERMINAL_PROMPT=0` is what makes
 * the timeout a backstop rather than the mechanism — the realistic way to block
 * forever is a credential prompt on stdin, and that is turned off below.
 */
const GIT_TIMEOUT_MS = 20_000

/** The absent side of an add or a delete, and every side of a file with no bytes to show. */
const ABSENT: BlobSide = { kind: 'absent' }

/** git prints forty zeros for the side that does not exist. It is not an object id. */
const ZERO_SHA = '0'.repeat(40)

const SHA = /^[0-9a-f]{40}$/i

// ---------------------------------------------------------------------------
// The one invocation.
// ---------------------------------------------------------------------------

interface GitRun {
  /** A repository root this file discovered. Never a request value. */
  readonly repo: string
  /** The subcommand and its flags, written out here as literals. */
  readonly args: readonly string[]
  /** Operands — refs, ranges, patterns. Placed after `--end-of-options`. */
  readonly values?: readonly string[]
  /** Written to stdin and closed. Only `cat-file --batch` uses it. */
  readonly input?: string
  /**
   * Takes stdout in chunks instead of accumulating it, so a caller that must
   * refuse a large object never has it in memory. `stdout` is empty when this
   * is given.
   */
  readonly onData?: (chunk: Buffer) => void
}

interface GitOutput {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

function gitArgs(run: GitRun): string[] {
  const values = run.values ?? []

  for (const value of values) {
    // Unreachable if the whitelist above holds — a ref name from `for-each-ref`
    // begins with `refs/`, and a directory name that begins with `-` never
    // becomes a value. It is here because "unreachable" is a claim about today's
    // callers and this is the last place a wrong one can be caught.
    if (value.startsWith('-')) {
      throw new Error(`Refusing to pass \`${value}\` to git: an operand cannot begin with a dash.`)
    }
  }

  return [
    '-C',
    run.repo,
    '--no-optional-locks',
    ...run.args,
    ...(values.length > 0 ? ['--end-of-options', ...values] : []),
  ]
}

/**
 * One `git`, with an argv array — never a shell, never `exec`, never a string.
 *
 * A non-zero exit is a **result**, not a rejection: the target ladder is driven
 * by exit codes and `rev-parse` on a directory that is not a repository is an
 * expected 128. The promise rejects only when there was no answer at all —
 * `git` could not be started, or it had to be killed.
 *
 * `--end-of-options` is appended only when there are operands to separate.
 * `git rev-parse --show-toplevel --end-of-options` **prints the flag** rather
 * than ignoring it (measured on 2.55.0), which would put a line of garbage in
 * front of every answer.
 */
function git(run: GitRun): Promise<GitOutput> {
  const args = gitArgs(run)

  return new Promise((settle, fail) => {
    const child = spawn('git', args, {
      env: {
        ...process.env,
        // No invocation may block waiting for a credential. Nothing here talks
        // to a remote, so a prompt would mean something has gone wrong in a way
        // that a hung page is the worst possible way to report.
        GIT_TERMINAL_PROMPT: '0',
        // Git for Windows ships translations, and one message below is matched
        // rather than merely shown: the rename-limit warning. Pinning the
        // locale means that recogniser does not quietly stop working on a
        // machine with a localised git.
        LC_ALL: 'C',
      },
      windowsHide: true,
      timeout: GIT_TIMEOUT_MS,
    })

    const out: Buffer[] = []
    const err: Buffer[] = []

    child.stdout.on('data', (chunk: Buffer) => {
      if (run.onData === undefined) out.push(chunk)
      else run.onData(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk))

    // git can exit before it has read all of stdin — `cat-file --batch` given a
    // sha it dislikes is the live case — and the write that lands afterwards is
    // an EPIPE on a stream nobody is listening to, which takes the process down.
    child.stdin.on('error', () => {})

    child.on('error', fail)
    child.on('close', (code, signal) => {
      if (signal !== null) {
        fail(new Error(`git ${run.args[0]} was killed after ${GIT_TIMEOUT_MS} ms (${signal}).`))
        return
      }

      settle({
        code: code ?? 0,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8').trim(),
      })
    })

    child.stdin.end(run.input ?? '')
  })
}

function failureText(run: GitRun, result: GitOutput): string {
  const first = result.stderr.split('\n')[0] ?? ''

  return `git ${run.args[0]} failed (exit ${result.code})${first === '' ? '' : `: ${first}`}`
}

/** The invocations whose failure is nobody's expected answer. */
async function ok(run: GitRun): Promise<string> {
  const result = await git(run)
  if (result.code !== 0) throw new Error(failureText(run, result))

  return result.stdout
}

// ---------------------------------------------------------------------------
// Roots, and what is under them.
// ---------------------------------------------------------------------------

/**
 * `ADO_WEB_REPOS_ROOT`, `path.delimiter`-separated, or `~/repos`.
 *
 * The `configured` flag rides along because the page says a different sentence
 * for each: a default that is not there is "point the app at your
 * repositories", and a named root that is not there is a typo somebody wants to
 * see quoted back.
 */
function rootPaths(): { path: string; configured: boolean }[] {
  const named = (process.env.ADO_WEB_REPOS_ROOT ?? '')
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')

  if (named.length > 0) return named.map((path) => ({ path: resolve(path), configured: true }))

  return [{ path: join(homedir(), 'repos'), configured: false }]
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

interface Candidate {
  /** The directory basename. The only name a URL ever carries. */
  readonly slug: string
  readonly dir: string
}

/**
 * One level deep and never recursive. The root holds three orphaned
 * `node_modules` directories and `platform` alone has 13,807 tracked files, so
 * a recursive walk reads tens of thousands of directories to find nineteen
 * `.git`s.
 */
async function children(root: string): Promise<Candidate[]> {
  const entries = await readdir(root, { withFileTypes: true })

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ slug: entry.name, dir: join(root, entry.name) }))
}

function samePath(left: string, right: string): boolean {
  const a = resolve(left)
  const b = resolve(right)

  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

/**
 * The repository test, and the reason it is not `existsSync('.git')`: it also
 * admits a worktree, where `.git` is a file.
 *
 * **The equality check is the whole of it.** `rev-parse --show-toplevel` answers
 * from anywhere *inside* a repository, so a child that is merely a directory in
 * one — a `node_modules` under a checkout, or every child of a root that is
 * itself a repository — answers with its ancestor's toplevel and would
 * otherwise be listed as a repository of its own. A child is a repository only
 * when the toplevel git names is the child itself.
 *
 * `null` means "not a repository", which is not a failure and not a row.
 *
 * The answer is `resolve`d before it is returned because git prints a Windows
 * path with forward slashes — `C:/Users/…` — and this string is both shown on
 * the page beside a root spelled the other way and handed back to `-C`.
 */
async function toplevel(dir: string): Promise<string | null> {
  const result = await git({ repo: dir, args: ['rev-parse', '--show-toplevel'] })
  if (result.code !== 0) return null

  const top = result.stdout.trim()

  return top !== '' && samePath(top, dir) ? resolve(top) : null
}

// ---------------------------------------------------------------------------
// Refs, HEAD, and the target ladder.
// ---------------------------------------------------------------------------

/** Tab-separated because a ref name may contain anything else, including a space. */
const REF_FORMAT = '%(refname)%09%(objectname)%09%(committerdate:iso-strict)%09%(symref)'

/**
 * Everything the list page needs about one repository's refs, in one
 * invocation: its local branches and all three remote rungs of the ladder.
 *
 * `refs/heads` is 3 refs in 57 ms and `refs/remotes/origin` is 1,264 in 308 ms
 * on `platform`, which is why the remote half is three named refs here and not
 * a namespace. The full remote list is `loadRemoteRefs`, on demand.
 */
const SCAN_PATTERNS: readonly string[] = [
  'refs/heads',
  'refs/remotes/origin/HEAD',
  'refs/remotes/origin/main',
  'refs/remotes/origin/master',
]

/**
 * The ladder, in the order it is tried.
 *
 * **Not `rev-parse origin/HEAD`.** That is what the research note measured, and
 * it *fatals* rather than answering empty on the 2 of 19 repositories with no
 * remote at all — so a ladder built on it must be driven by exit codes, and one
 * built on it carelessly reads a crash as a blank and falls through by
 * accident. Reading the refs instead removes the hazard rather than handling
 * it: absence is a ref that is not in the enumeration, and a failure is the
 * whole enumeration failing, and the two cannot be confused.
 */
const LADDER: readonly { readonly rung: TargetRung; readonly ref: string }[] = [
  { rung: 'origin-head', ref: 'refs/remotes/origin/HEAD' },
  { rung: 'origin-main', ref: 'refs/remotes/origin/main' },
  { rung: 'origin-master', ref: 'refs/remotes/origin/master' },
  { rung: 'local-branch', ref: 'refs/heads/main' },
  { rung: 'local-branch', ref: 'refs/heads/master' },
]

interface RefRow {
  readonly fullName: string
  readonly commit: string
  readonly committedAt: string
  /** Where a symbolic ref points, full name. Empty for an ordinary ref. */
  readonly symref: string
}

const refName = (fullName: string): string => fullName.replace(/^refs\/(?:heads|remotes)\//, '')

const toGitRef = (row: RefRow): GitRef => ({
  name: refName(row.fullName),
  fullName: row.fullName,
  commit: row.commit,
})

async function refRows(repo: string, patterns: readonly string[]): Promise<RefRow[]> {
  const out = await ok({ repo, args: ['for-each-ref', `--format=${REF_FORMAT}`], values: patterns })

  return out
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const [fullName, commit, committedAt, symref] = line.split('\t')

      return { fullName, commit, committedAt, symref: symref ?? '' }
    })
}

/**
 * Where the repository is sitting, from the refs already in hand plus one
 * invocation.
 *
 * `branch --show-current` rather than `rev-parse HEAD`, because `rev-parse`
 * **fatals** in a repository with no commits while the branch name is perfectly
 * readable — and a fresh `git init` rendering as an error row is exactly the
 * kind of thing that makes a list untrustworthy. Unborn then falls out for
 * free: a branch that names no row in `refs/heads` is a branch with no commit
 * on it yet.
 */
async function readHead(repo: string, locals: readonly RefRow[]): Promise<RepoHead> {
  const current = (await ok({ repo, args: ['branch', '--show-current'] })).trim()

  if (current === '') {
    // Detached. Nothing symbolic to read, and there is always a commit — the
    // unborn case cannot reach here, because an unborn HEAD still has a name.
    const commit = (await ok({ repo, args: ['rev-parse', '--verify', '--quiet'], values: ['HEAD'] }))
      .trim()

    return { kind: 'detached', commit }
  }

  const row = locals.find((ref) => ref.fullName === `refs/heads/${current}`)

  return row === undefined
    ? { kind: 'unborn', name: current }
    : { kind: 'branch', name: current, commit: row.commit }
}

/**
 * What to diff against, or what was tried.
 *
 * `origin/HEAD` is a symbolic ref, so the ref that goes on to argv is the one it
 * points *at* — `refs/remotes/origin/develop` reads better on the page than
 * `origin/HEAD` and is the same object either way. Its commit and date come
 * from the row regardless, because a ref lookup resolves through the symref.
 */
function resolveTarget(rows: readonly RefRow[]): TargetResolution {
  const tried: string[] = []

  for (const rung of LADDER) {
    tried.push(refName(rung.ref))

    const row = rows.find((ref) => ref.fullName === rung.ref)
    if (row === undefined) continue

    const fullName = row.symref === '' ? row.fullName : row.symref

    return {
      kind: 'resolved',
      rung: rung.rung,
      ref: { name: refName(fullName), fullName, commit: row.commit },
      baseCommittedAt: row.committedAt,
    }
  }

  return { kind: 'unresolved', tried }
}

const isLocal = (row: RefRow): boolean => row.fullName.startsWith('refs/heads/')

async function describe(
  slug: string,
  path: string,
): Promise<{ repository: LocalRepository; rows: RefRow[] }> {
  const rows = await refRows(path, SCAN_PATTERNS)

  return {
    repository: {
      kind: 'repository',
      slug,
      path,
      head: await readHead(path, rows.filter(isLocal)),
      target: resolveTarget(rows),
      unaddressable: null,
    },
    rows,
  }
}

// ---------------------------------------------------------------------------
// The scan.
// ---------------------------------------------------------------------------

const unreadable = (candidate: Candidate, error: unknown): RepositoryEntry => ({
  kind: 'unreadable',
  slug: candidate.slug,
  path: candidate.dir,
  message: error instanceof Error ? error.message : String(error),
})

/**
 * `null` for a child that is not a repository — the three `node_modules` and
 * whatever else lives beside them. A repository that *is* one and could not be
 * read stays in the list as a row, because one bad repository must not blank
 * the other eighteen and must not silently shorten the list either.
 */
async function entryFor(candidate: Candidate): Promise<RepositoryEntry | null> {
  const path = await toplevel(candidate.dir)
  if (path === null) return null

  try {
    return (await describe(candidate.slug, path)).repository
  } catch (error) {
    return unreadable(candidate, error)
  }
}

/**
 * Two repositories sharing a basename across two roots. Both are listed, with
 * their paths, and **neither is addressable**: numbering them would mean a
 * third arrival renumbers the second, and the viewed marks keyed on the slug
 * would then silently re-point at a different repository.
 */
function markCollisions(entries: readonly RepositoryEntry[]): RepositoryEntry[] {
  const counts = new Map<string, number>()
  for (const entry of entries) counts.set(entry.slug, (counts.get(entry.slug) ?? 0) + 1)

  return entries.map((entry) => {
    if (entry.kind !== 'repository' || (counts.get(entry.slug) ?? 0) < 2) return entry

    return { ...entry, unaddressable: `Two repositories under your roots are called \`${entry.slug}\`.` }
  })
}

/**
 * Every repository under every root. **Never cached**: a repository appeared
 * under the root during the session that designed this, and a cached scan is a
 * list that is wrong exactly when somebody has just cloned something.
 *
 * The repositories are read concurrently and the roots are not. Nineteen
 * `status` calls in parallel measured 2.16 s against 2.7 s sequential — a disk,
 * not a queue — but that was 14,000 files of work, and this is three spawns of
 * ~52 ms each where process start *is* the cost.
 */
export async function scanRepositories(): Promise<RepositoryScan> {
  const roots: ScannedRoot[] = []
  const candidates: Candidate[] = []

  for (const { path, configured } of rootPaths()) {
    const exists = await isDirectory(path)
    roots.push({ path, configured, exists })
    if (exists) candidates.push(...(await children(path)))
  }

  const entries = await Promise.all(candidates.map(entryFor))

  return { roots, repositories: markCollisions(entries.filter((entry) => entry !== null)) }
}

/**
 * A slug back to a repository, and the reason no request value is ever a path:
 * the slug is compared for **equality** against directory names the filesystem
 * just produced, so the only strings that get anywhere are ones that name a
 * real child of a configured root.
 *
 * Not a full `scanRepositories`: opening one file's blobs would then cost three
 * spawns per repository under the root. Discovery here is a `readdir` and one
 * `rev-parse` on the children that match by name — which is also what makes the
 * collision check honest, since it counts matches across every root rather than
 * stopping at the first.
 */
async function locate(slug: string): Promise<string> {
  const dirs: string[] = []

  for (const { path } of rootPaths()) {
    if (!(await isDirectory(path))) continue
    for (const child of await children(path)) {
      if (child.slug === slug) dirs.push(child.dir)
    }
  }

  const tops = (await Promise.all(dirs.map(toplevel))).filter((top) => top !== null)

  if (tops.length === 0) throw new Error(`No repository named \`${slug}\` under your roots.`)
  if (tops.length > 1) {
    throw new Error(
      `Two repositories under your roots are called \`${slug}\`, so neither can be opened by name.`,
    )
  }

  return tops[0]
}

/** One repository opened: its refs, its HEAD and its target. Remotes are not read here. */
export async function openRepository(slug: string): Promise<RepositoryDetail> {
  const path = await locate(slug)
  const { repository, rows } = await describe(slug, path)

  return { repository, refs: { local: rows.filter(isLocal).map(toGitRef), remote: null } }
}

/**
 * The remote-tracking refs, which nothing asks for until a picker is opened:
 * 1,264 of them in 308 ms on `platform`, against 57 ms for the three locals.
 *
 * `refs/remotes` rather than `refs/remotes/origin`, because `refs/remotes/*` is
 * a namespace and not a promise about origin — `ado-web` carries a stray
 * `refs/remotes/local-main` under no remote at all. The `HEAD` symrefs are
 * dropped: `origin/HEAD` is a second name for a branch already in the list, and
 * a picker offering both offers the same diff twice.
 */
export async function loadRemoteRefs(slug: string): Promise<readonly GitRef[]> {
  const path = await locate(slug)
  const rows = await refRows(path, ['refs/remotes'])

  return rows.filter((row) => !row.fullName.endsWith('/HEAD')).map(toGitRef)
}

// ---------------------------------------------------------------------------
// The change set.
// ---------------------------------------------------------------------------

/**
 * A branch by name, out of the set this server enumerated for this repository.
 *
 * Locals first and remotes only if the name is not among them, so the common
 * case never pays the 308 ms — and a name in neither set **fails closed**.
 *
 * The row rather than the `GitRef` it becomes, because a pinned target's
 * `committedAt` is on the row and nowhere else, and the header states how old
 * the base is whether the ladder chose it or the URL did.
 */
async function selectRow(path: string, locals: readonly RefRow[], name: string): Promise<RefRow> {
  const local = locals.find((row) => refName(row.fullName) === name)
  if (local !== undefined) return local

  const remote = (await refRows(path, ['refs/remotes'])).find((row) => refName(row.fullName) === name)
  if (remote !== undefined) return remote

  throw new Error(`No branch named \`${name}\` in this repository.`)
}

/**
 * The branch to diff when the URL did not name one.
 *
 * Both other kinds of HEAD fail closed with words rather than resolving to
 * something plausible: a detached HEAD has no branch to be the left-hand side of
 * this question, and an unborn one has no commit to diff at all. Saying so — and
 * saying `?branch=` is how you answer it — is the whole of the handling.
 */
async function currentBranch(
  slug: string,
  path: string,
  locals: readonly RefRow[],
): Promise<string> {
  const head = await readHead(path, locals)

  if (head.kind === 'branch') return head.name
  if (head.kind === 'unborn') {
    throw new Error(`\`${slug}\` has no commits yet, so there is nothing to diff.`)
  }

  throw new Error(
    'HEAD is detached, so there is no branch to diff. Name one in the URL with `?branch=`.',
  )
}

const changeType = (letter: string, before: string, after: string, path: string): string[] => {
  switch (letter) {
    case 'A':
      return ['add']
    case 'D':
      return ['delete']
    // A type change — a file becoming a symlink, or a symlink becoming a file.
    // Its bytes changed and the diff renders them; nothing else here cares.
    case 'M':
    case 'T':
      return ['edit']
    // `-C` is not passed, so a copy cannot arrive. If one ever does, Azure
    // DevOps has no word for it and it would render as an add anyway.
    case 'C':
      return ['add']
    case 'R':
      return before === after ? ['rename'] : ['rename', 'edit']
    // `U` — unmerged — is unreachable from a tree-to-tree diff, and `X` is git
    // saying it does not know either. Both arrive here, with the letter, rather
    // than being folded into `edit` and rendered as a diff of the wrong thing.
    default:
      throw new Error(`git reported change type \`${letter}\` for ${path}, which has no meaning here.`)
  }
}

const objectId = (sha: string): string | null => (sha === ZERO_SHA ? null : sha)

const fileMode = (mode: string): string | null => (mode === '000000' ? null : mode)

/**
 * `--raw -z`: `:<before mode> <after mode> <before sha> <after sha> <status>`,
 * NUL, the path, NUL — and for a rename the old path and then the new one.
 *
 * Both flags are load-bearing and neither is a formatting preference. Without
 * `--abbrev=40` the object ids come back **seven characters**, which is a prefix
 * and not a content address. Without `-z` the paths are **C-quoted**, and only
 * the ones that need it, so a naive parser works on every file in the
 * repository until somebody commits one with a space in its name.
 */
function parseRaw(out: string): LocalChangedFile[] {
  const tokens = out.split('\0')
  const files: LocalChangedFile[] = []
  let at = 0

  while (at < tokens.length) {
    const header = tokens[at++]
    // The trailing NUL of the last record leaves one empty token behind it.
    if (header === '') continue
    if (!header.startsWith(':')) {
      throw new Error(`Could not read git's diff output: expected a record, got \`${header}\`.`)
    }

    const [beforeMode, afterMode, before, after, status] = header.slice(1).split(' ')
    const letter = status.charAt(0)
    // `R` and `C` carry a similarity score and two paths; everything else has
    // one path and a bare letter.
    const renamed = letter === 'R' || letter === 'C'
    const first = tokens[at++]
    const path = renamed ? tokens[at++] : first

    files.push({
      path,
      changeType: changeType(letter, before, after, path),
      originalPath: letter === 'R' ? first : null,
      objectId: objectId(after),
      originalObjectId: objectId(before),
      beforeMode: fileMode(beforeMode),
      afterMode: fileMode(afterMode),
    })
  }

  return files
}

/**
 * The warning `-M` writes when it gives up.
 *
 * Past `diff.renameLimit` (1000 by default) git stops detecting renames, says
 * so on **stderr**, and **exits 0** — so every rename in a large refactor
 * arrives as an add plus a delete and the page has nothing to say about it
 * unless this fires. Never observed firing: the exact wording is transcribed
 * from git's source rather than from a run, which is why it matches two
 * fragments rather than a sentence.
 */
const RENAME_LIMIT = /rename detection was skipped|diff\.renameLimit/i

/**
 * What is between a branch and whatever the ladder says it belongs to.
 *
 * `--merge-base` and not a two-dot range: the question is "what has this branch
 * changed", and a target that has moved on since the branch left it would
 * otherwise contribute every commit made on it as a reversal. It needs git
 * 2.30; measured working on 2.55.0.
 *
 * Both names are nullable and mean "resolve it now": the branch from `HEAD`, the
 * target from the ladder. That is what `/repos/$repo` with nothing after it asks
 * for, and it is why the page can fetch this without first fetching the
 * repository to find out what it is sitting on. A name that *is* given is looked
 * up in the set enumerated a line above and **fails closed** if it is not there —
 * a branch deleted in a terminal after the page loaded says so rather than
 * quietly diffing something else.
 */
export async function loadLocalChanges(
  slug: string,
  branch: string | null,
  target: string | null,
): Promise<LocalChangeSet> {
  const path = await locate(slug)
  const rows = await refRows(path, SCAN_PATTERNS)
  const locals = rows.filter(isLocal)

  const named = branch ?? (await currentBranch(slug, path, locals))
  const ref = toGitRef(await selectRow(path, locals, named))
  const base = await resolveBase(path, rows, locals, named, target)

  const run: GitRun = {
    repo: path,
    args: ['diff', '--raw', '-M', '--abbrev=40', '-z', '--merge-base'],
    values: [base.base.fullName, ref.fullName],
  }

  const diff = await git(run)
  if (diff.code !== 0) throw new Error(failureText(run, diff))

  const files = parseRaw(diff.stdout)
  const counted = await ok({
    repo: path,
    args: ['rev-list', '--count'],
    values: [`${base.base.fullName}..${ref.fullName}`],
  })

  return {
    files: files.slice(0, FILE_LIMIT),
    truncated: files.length > FILE_LIMIT,
    renameDetectionSkipped: RENAME_LIMIT.test(diff.stderr),
    commits: Number(counted.trim()),
    diffed: { ...base, branch: ref },
  }
}

/**
 * The right-hand half of a `DiffPair`: what this branch is being compared to,
 * and how that was decided.
 *
 * A pinned target gets `rung: null` because no rung was climbed — printing
 * "origin's default branch" beside a ref the URL chose would be a claim nobody
 * made — and it resolves through `selectRow`, so pinning is a selection from the
 * enumerated set and not a string on its way to argv.
 */
async function resolveBase(
  path: string,
  rows: readonly RefRow[],
  locals: readonly RefRow[],
  branch: string,
  target: string | null,
): Promise<Omit<DiffPair, 'branch'>> {
  if (target !== null) {
    const row = await selectRow(path, locals, target)

    return { base: toGitRef(row), rung: null, baseCommittedAt: row.committedAt }
  }

  const resolved = resolveTarget(rows)
  if (resolved.kind === 'unresolved') {
    throw new Error(
      `Nothing to diff \`${branch}\` against — tried ${resolved.tried.join(', ')}. This repository has no origin.`,
    )
  }

  return {
    base: resolved.ref,
    rung: resolved.rung,
    baseCommittedAt: resolved.baseCommittedAt,
  }
}

/** Uncommitted entries, on its own so a 216 ms `status` never delays the diff. */
export async function loadDirtyCount(slug: string): Promise<number> {
  const path = await locate(slug)
  const out = await ok({ repo: path, args: ['status', '--porcelain=v2'] })

  return out.split('\n').filter((line) => line.trim() !== '').length
}

// ---------------------------------------------------------------------------
// Blobs.
// ---------------------------------------------------------------------------

/**
 * The fields of a `LocalChangedFile` a blob fetch needs, so the caller passes
 * the row it already has rather than a translation of it — `blob.ts`'s
 * `BlobRequest` bargain, plus the two modes, which are what keeps a gitlink away
 * from `cat-file` and what tells a mode flip from a file that did not change.
 */
export interface LocalBlobRequest {
  readonly path: string
  readonly originalPath: string | null
  readonly objectId: string | null
  readonly originalObjectId: string | null
  readonly beforeMode: string | null
  readonly afterMode: string | null
}

const short = (sha: string): string => sha.slice(0, 7)

/**
 * A gitlink names a commit that is not in this object database, so `cat-file`
 * would answer `missing` and the page would read as a fetch failure. It is
 * recognised from its mode and stated instead — and it is **not** a fifth
 * `BlobSide` arm, for a case 0 of 19 repositories here can produce.
 */
function submoduleNote(file: LocalBlobRequest): string | null {
  if (file.beforeMode !== '160000' && file.afterMode !== '160000') return null
  if (file.originalObjectId !== null && file.objectId !== null) {
    return `Submodule, moved from \`${short(file.originalObjectId)}\` to \`${short(file.objectId)}\`.`
  }

  return file.objectId !== null
    ? `Submodule added at \`${short(file.objectId)}\`.`
    : `Submodule removed at \`${short(file.originalObjectId ?? ZERO_SHA)}\`.`
}

interface BatchReader {
  feed(chunk: Buffer): void
  sides(): Map<string, BlobSide>
}

/**
 * `cat-file --batch`'s output, which is framed by a declared size and has no
 * delimiter to resynchronise on:
 *
 * ```
 * <sha> SP <type> SP <size> LF
 * <size bytes>
 * LF
 * ```
 *
 * or `<sha> SP missing LF` for a sha the object database does not hold.
 *
 * **The size arrives before the bytes do**, which is what finally gives
 * `BlobSide`'s `too-large` arm a live domain — `diff-contract.ts` records that
 * Azure DevOps declares a length only below ~256 KiB, so the same check there
 * refuses nothing that ever happens. Here an over-limit blob is refused
 * *without being buffered*: `body` goes null and the bytes are counted past
 * rather than kept.
 *
 * **But they must still be counted past.** Skipping the read does not skip the
 * bytes on the pipe, and every record after the refused one would then parse as
 * garbage. Refuse the content, read the bytes.
 */
function batchReader(): BatchReader {
  const found = new Map<string, BlobSide>()

  let carry = Buffer.alloc(0)
  let sha = ''
  let size = 0
  let need = 0
  let trailer = 0
  let body: Buffer[] | null = null

  function header(line: string): void {
    const [id, type, declared] = line.split(' ')

    if (type === 'missing' || declared === undefined) {
      found.set(id, { kind: 'failed', message: `git has no object \`${short(id)}\`.` })
      return
    }

    sha = id
    size = Number(declared)
    need = size
    trailer = 1
    body = size > MAX_BLOB_BYTES ? null : []
  }

  function finish(): void {
    found.set(sha, body === null ? { kind: 'too-large', bytes: size } : readBlob(Buffer.concat(body)))
    body = null
  }

  return {
    feed(chunk: Buffer): void {
      let at = 0

      while (at < chunk.length) {
        if (need > 0) {
          const take = Math.min(need, chunk.length - at)
          if (body !== null) body.push(chunk.subarray(at, at + take))
          at += take
          need -= take
          continue
        }

        if (trailer > 0) {
          at += 1
          trailer -= 1
          finish()
          continue
        }

        const lf = chunk.indexOf(0x0a, at)
        if (lf === -1) {
          carry = Buffer.concat([carry, chunk.subarray(at)])
          return
        }

        const line = Buffer.concat([carry, chunk.subarray(at, lf)]).toString('utf8')
        carry = Buffer.alloc(0)
        at = lf + 1
        header(line)
      }
    },
    sides: () => found,
  }
}

/**
 * Both sides of one file in **one** spawn, not two.
 *
 * 200 blobs through a single `cat-file --batch` is ~10 ms each against ~52 ms
 * for a spawn, which on a 294-file change is ~6 s against ~31 s. One process
 * per *file* rather than one for the whole change set because a diff panel opens
 * one file at a time, and a batch that answered every file would be a batch
 * nobody is waiting for.
 */
async function catFile(path: string, shas: readonly string[]): Promise<Map<string, BlobSide>> {
  const reader = batchReader()
  const run: GitRun = {
    repo: path,
    args: ['cat-file', '--batch'],
    input: `${shas.join('\n')}\n`,
    onData: (chunk) => reader.feed(chunk),
  }

  const result = await git(run)
  if (result.code !== 0) throw new Error(failureText(run, result))

  return reader.sides()
}

/** Both blobs of one changed file, or the sentence to print instead of them. */
export async function loadLocalBlobs(
  slug: string,
  file: LocalBlobRequest,
): Promise<LocalFileBlobs> {
  const path = await locate(slug)
  const blank = { path: file.path, before: ABSENT, after: ABSENT }

  const submodule = submoduleNote(file)
  if (submodule !== null) return { ...blank, renamedOnly: false, note: submodule }

  // The bytes did not move. Which of the two things that means is decided by
  // the paths and not by the shas: `blob.ts` reads sha equality as a pure
  // rename, and a mode flip satisfies it while renaming nothing.
  if (file.objectId !== null && file.objectId === file.originalObjectId) {
    if (file.originalPath !== null && file.originalPath !== file.path) {
      return { ...blank, renamedOnly: true, note: null }
    }
    if (file.beforeMode !== file.afterMode) {
      return {
        ...blank,
        renamedOnly: false,
        note: `Mode changed, ${file.beforeMode} → ${file.afterMode}.`,
      }
    }
  }

  for (const sha of [file.originalObjectId, file.objectId]) {
    // The whitelist's last link: nothing that is not forty hex digits is
    // written to `cat-file`'s stdin.
    if (sha !== null && !SHA.test(sha)) {
      throw new Error(`\`${sha}\` is not an object id.`)
    }
  }

  const wanted = [...new Set([file.originalObjectId, file.objectId].filter((sha) => sha !== null))]
  const sides = wanted.length === 0 ? new Map<string, BlobSide>() : await catFile(path, wanted)
  const side = (sha: string | null): BlobSide =>
    sha === null ? ABSENT : (sides.get(sha) ?? { kind: 'failed', message: `git did not answer for \`${short(sha)}\`.` })

  return {
    path: file.path,
    before: side(file.originalObjectId),
    after: side(file.objectId),
    renamedOnly: false,
    note: null,
  }
}
