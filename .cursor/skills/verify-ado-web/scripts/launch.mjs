// Starts one isolated verification instance of ado-web and waits until it answers.
//
//   node .cursor/skills/verify-ado-web/scripts/launch.mjs [--port 7341] [--repos <dir>] [--fresh-credentials]
//
// Prints the run record. Every later script reads it from latest.json.

import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, openSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { join } from 'node:path'

import {
  BASE_DIR,
  DEFAULT_PORT,
  LATEST,
  REPO_ROOT,
  RUNS_DIR,
  SKILL_DIR,
  USER_PORT,
  arg,
  fetchLaunchToken,
  saveRun,
  stamp,
} from './common.mjs'

const port = Number(arg('port', DEFAULT_PORT))
const freshCredentials = arg('fresh-credentials', false) === true
const reposArg = arg('repos')

if (port === USER_PORT) {
  console.error(`Port ${USER_PORT} belongs to the user's own pnpm dev. Pick another --port.`)
  process.exit(2)
}

const taken = await new Promise((done) => {
  const socket = createConnection({ host: '127.0.0.1', port })
  socket.once('connect', () => (socket.destroy(), done(true)))
  socket.once('error', () => done(false))
})
if (taken) {
  console.error(`Port ${port} already answers. Run doctor.mjs, or stop.mjs, or pick another --port.`)
  process.exit(2)
}

const runId = stamp()
const runDir = join(RUNS_DIR, `${runId}-${port}`)
const dataDir = join(runDir, 'data')
const evidenceDir = join(runDir, 'evidence')
const ownsRepos = typeof reposArg !== 'string'
const reposRoot = ownsRepos ? join(runDir, 'repos') : reposArg
mkdirSync(dataDir, { recursive: true })
mkdirSync(evidenceDir, { recursive: true })

if (ownsRepos) buildFixture(reposRoot)

const run = {
  runId,
  port,
  url: `http://127.0.0.1:${port}`,
  runDir,
  dataDir,
  evidenceDir,
  reposRoot,
  ownsRepos,
  // A fresh keyring service starts with no credential, so onboarding can be driven
  // without touching the user's real `ado-web` entries.
  keyringService: freshCredentials ? `ado-web-verify-${runId}` : 'ado-web',
  ownsKeyring: freshCredentials,
  cacheDir: join(BASE_DIR, `vite-cache-${port}`),
  log: join(runDir, 'server.log'),
  writeLedger: join(evidenceDir, 'writes.jsonl'),
  startedAt: new Date().toISOString(),
}

const log = openSync(run.log, 'a')
const child = spawn(
  process.execPath,
  [join('node_modules', 'vite', 'bin', 'vite.js'), 'dev', '--config', join(SKILL_DIR, 'scripts', 'vite.verify.config.mjs')],
  {
    cwd: REPO_ROOT,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', log, log],
    env: {
      ...process.env,
      ADO_WEB_VERIFY_PORT: String(port),
      ADO_WEB_VERIFY_CACHE: run.cacheDir,
      ADO_WEB_DATA_DIR: dataDir,
      ADO_WEB_REPOS_ROOT: reposRoot,
      ADO_WEB_KEYRING_SERVICE: run.keyringService,
      // Records every ADO write and its re-read. It sends nothing itself.
      ADO_WEB_WRITE_LEDGER: run.writeLedger,
      NO_COLOR: '1',
    },
  },
)
child.unref()
run.pid = child.pid
saveRun(run)
writeFileSync(LATEST, JSON.stringify({ runDir }, null, 2))

// A cold Vite cache takes about 40 s to optimize dependencies.
const deadline = Date.now() + 180_000
let ready = false
while (Date.now() < deadline) {
  try {
    const page = await fetch(run.url)
    const token = await fetchLaunchToken(run.url)
    if (page.status === 200 && /^[0-9a-f]{64}$/.test(token.body)) {
      ready = true
      break
    }
  } catch {}
  await new Promise((r) => setTimeout(r, 1000))
}

console.log(JSON.stringify(run, null, 2))
if (!ready) {
  console.error(`Not ready after 180 s. Read ${run.log}, then run stop.mjs.`)
  process.exit(1)
}
console.log(`READY ${run.url}`)

/** One repository with a feature branch two commits ahead of `main`, and no remote. */
function buildFixture(root) {
  const repo = join(root, 'sample')
  mkdirSync(join(repo, 'src'), { recursive: true })
  const git = (...args) =>
    execFileSync(
      'git',
      ['-c', 'user.name=verify', '-c', 'user.email=verify@example.invalid', '-c', 'core.autocrlf=false', ...args],
      { cwd: repo, stdio: 'pipe' },
    )
  git('init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'README.md'), '# sample\n')
  writeFileSync(join(repo, 'src', 'app.js'), "export const greeting = 'hello'\n")
  git('add', '.')
  git('commit', '-q', '-m', 'chore: start the sample')
  git('checkout', '-q', '-b', 'feature/verify')
  writeFileSync(join(repo, 'src', 'app.js'), "export const greeting = 'hello, verify-marker'\n")
  git('commit', '-q', '-am', 'feat: change the greeting')
  writeFileSync(join(repo, 'notes.md'), 'verify-notes-line\n')
  git('add', 'notes.md')
  git('commit', '-q', '-m', 'docs: add notes')
}
