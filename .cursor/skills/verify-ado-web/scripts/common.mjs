// Shared paths and run-record helpers for the verify-ado-web scripts.
// `.mjs` on purpose: tsconfig.json includes `**/*.ts`, so a `.ts` helper here
// would join `pnpm typecheck`.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const REPO_ROOT = resolve(SKILL_DIR, '..', '..', '..')

// Outside the repo, so evidence never shows up in `git status` and survives a clean.
export const BASE_DIR = join(
  process.env.LOCALAPPDATA ?? join(homedir(), '.local', 'share'),
  'ado-web-verify',
)
export const RUNS_DIR = join(BASE_DIR, 'runs')
export const LATEST = join(BASE_DIR, 'latest.json')

// The user's own `pnpm dev`. Verification never binds or drives it.
export const USER_PORT = 7331
export const DEFAULT_PORT = 7341

export function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1) return fallback
  const next = process.argv[i + 1]
  return next === undefined || next.startsWith('--') ? true : next
}

/** The run named by `--run <dir>`, else the most recent launch. */
export function loadRun() {
  const explicit = arg('run')
  const runDir =
    typeof explicit === 'string'
      ? explicit
      : existsSync(LATEST)
        ? JSON.parse(readFileSync(LATEST, 'utf8')).runDir
        : null
  if (!runDir || !existsSync(join(runDir, 'run.json'))) {
    console.error('No run found. Start one with: node .cursor/skills/verify-ado-web/scripts/launch.mjs')
    process.exit(2)
  }
  return JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8'))
}

export function saveRun(run) {
  writeFileSync(join(run.runDir, 'run.json'), JSON.stringify(run, null, 2))
}

export function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** The request guard wants a loopback Host and a same-origin fetch for the token. */
export async function fetchLaunchToken(url) {
  const response = await fetch(`${url}/__launch-token`, {
    headers: { origin: url, 'sec-fetch-site': 'same-origin', accept: 'text/plain' },
  })
  return { status: response.status, body: await response.text() }
}

export function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
}
