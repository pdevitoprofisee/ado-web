// Tears down one verification instance. Keeps the evidence and the server log.
//
//   node .cursor/skills/verify-ado-web/scripts/stop.mjs [--run <runDir>]

import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { REPO_ROOT, isAlive, loadRun, saveRun } from './common.mjs'

const run = loadRun()

// Only the pid this run started, with its children. Never by process name.
if (run.pid && isAlive(run.pid)) {
  if (process.platform === 'win32') {
    execFileSync('taskkill', ['/PID', String(run.pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    process.kill(-run.pid, 'SIGTERM')
  }
}
for (let i = 0; i < 20 && isAlive(run.pid); i++) await new Promise((r) => setTimeout(r, 250))
console.log(`server pid ${run.pid}: ${isAlive(run.pid) ? 'STILL ALIVE' : 'stopped'}`)

if (run.ownsKeyring) {
  const { Entry } = createRequire(join(REPO_ROOT, 'package.json'))('@napi-rs/keyring')
  for (const kind of ['azure-devops', 'sonarcloud']) new Entry(run.keyringService, kind).deleteCredential()
  console.log(`removed keyring entries under ${run.keyringService}`)
}

// Windows releases the SQLite file lock a moment after the process exits.
const remove = (dir) => rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
remove(run.dataDir)
// A --repos directory the caller passed in is theirs, never ours to delete.
if (run.ownsRepos) remove(run.reposRoot)

run.stoppedAt = new Date().toISOString()
saveRun(run)

console.log(`evidence kept: ${run.evidenceDir} (${existsSync(run.evidenceDir) ? 'present' : 'MISSING'})`)
console.log(`server log kept: ${run.log}`)
