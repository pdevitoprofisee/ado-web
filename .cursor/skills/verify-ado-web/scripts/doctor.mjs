// Read-only health check of the current verification instance.
//
//   node .cursor/skills/verify-ado-web/scripts/doctor.mjs [--run <runDir>]
//
// Exit 0: worth driving. Exit 1: do not drive it; read the FAIL lines.

import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { join } from 'node:path'

import { REPO_ROOT, USER_PORT, fetchLaunchToken, isAlive, loadRun } from './common.mjs'

const run = loadRun()
let failed = false
const report = (ok, label, detail = '') => {
  if (!ok) failed = true
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`)
}
const info = (label, detail) => console.log(`INFO  ${label}  (${detail})`)

info('run', `${run.runDir}`)
report(!run.stoppedAt, 'run not stopped', run.stoppedAt ?? '')
report(isAlive(run.pid), 'server process alive', `pid ${run.pid}`)

const owner = listenerPid(run.port)
report(owner === run.pid, `port ${run.port} owned by our pid`, `listener ${owner ?? 'none'}`)

try {
  const page = await fetch(run.url)
  report(page.status === 200, 'GET / answers 200', `status ${page.status}`)
  const token = await fetchLaunchToken(run.url)
  report(/^[0-9a-f]{64}$/.test(token.body), 'launch token handed out', `status ${token.status}`)
} catch (error) {
  report(false, 'server answers HTTP', error.message)
}

// Presence only. A credential value is never printed.
try {
  const { Entry } = createRequire(join(REPO_ROOT, 'package.json'))('@napi-rs/keyring')
  for (const kind of ['azure-devops', 'sonarcloud']) {
    const present = new Entry(run.keyringService, kind).getPassword() !== null
    info(`credential ${run.keyringService}/${kind}`, present ? 'present' : 'absent')
  }
} catch (error) {
  info('credential store', `unreadable: ${error.message}`)
}

try {
  info('git', execFileSync('git', ['--version'], { encoding: 'utf8' }).trim())
} catch {
  report(false, 'git on PATH')
}

const user = listenerPid(USER_PORT)
if (user !== null) info(`port ${USER_PORT}`, `user's own pnpm dev, pid ${user}: never drive it`)

process.exit(failed ? 1 : 0)

function listenerPid(port) {
  try {
    const out =
      process.platform === 'win32'
        ? execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' })
        : execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'], { encoding: 'utf8' })
    if (process.platform !== 'win32') return Number(out.match(/^p(\d+)/m)?.[1]) || null
    const line = out
      .split(/\r?\n/)
      .find((l) => /LISTENING/.test(l) && l.trim().split(/\s+/)[1]?.endsWith(`:${port}`))
    return line ? Number(line.trim().split(/\s+/).at(-1)) : null
  } catch {
    return null
  }
}
