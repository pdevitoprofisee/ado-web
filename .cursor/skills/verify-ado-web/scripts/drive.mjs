// Runs one drive script against the current verification instance in Chrome.
//
//   node .cursor/skills/verify-ado-web/scripts/drive.mjs <drive-script.mjs> [--headed] [--run <runDir>]
//
// A drive script default-exports `async ({ page, url, run, shot, note, expect }) => {}`.
// Evidence lands in <runDir>/evidence/<stamp>-<script name>/.

import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { BASE_DIR, USER_PORT, arg, loadRun, stamp } from './common.mjs'

const PLAYWRIGHT = 'playwright-core@1.63.0'
const TOOLS = join(BASE_DIR, 'tools')

const scriptArg = process.argv[2]
if (!scriptArg || scriptArg.startsWith('--')) {
  console.error('Usage: node drive.mjs <drive-script.mjs> [--headed] [--run <runDir>]')
  process.exit(2)
}
const script = resolve(scriptArg)
const run = loadRun()
if (run.stoppedAt) {
  console.error(`Run ${run.runDir} is stopped. Launch a new one.`)
  process.exit(2)
}
if (run.port === USER_PORT) {
  console.error(`Refusing to drive port ${USER_PORT}: it is the user's own instance.`)
  process.exit(2)
}

// Kept outside the repo so package.json and the lockfile never change.
const entry = join(TOOLS, 'node_modules', 'playwright-core', 'index.mjs')
if (!existsSync(entry)) {
  console.log(`Installing ${PLAYWRIGHT} into ${TOOLS} (once)...`)
  mkdirSync(TOOLS, { recursive: true })
  execFileSync('npm', ['install', '--prefix', TOOLS, '--no-audit', '--no-fund', PLAYWRIGHT], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
}
const { chromium } = await import(pathToFileURL(entry).href)

const out = join(run.evidenceDir, `${stamp()}-${basename(script, '.mjs')}`)
mkdirSync(out, { recursive: true })
const steps = join(out, 'steps.md')
writeFileSync(steps, `# ${basename(script)} against ${run.url}\n\n`)

let shots = 0
const note = (text) => {
  appendFileSync(steps, `- ${text}\n`)
  console.log(text)
}

let browser
for (const channel of ['chrome', 'msedge']) {
  try {
    browser = await chromium.launch({ channel, headless: arg('headed', false) !== true })
    break
  } catch (error) {
    note(`could not start ${channel}: ${error.message.split('\n')[0]}`)
  }
}
if (!browser) process.exit(1)

const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
await context.tracing.start({ screenshots: true, snapshots: true })
const page = await context.newPage()

page.on('console', (m) => appendFileSync(join(out, 'console.log'), `[${m.type()}] ${m.text()}\n`))
page.on('pageerror', (e) => appendFileSync(join(out, 'console.log'), `[pageerror] ${e.message}\n`))
page.on('response', (r) => {
  // Server functions are the only path to ADO, Sonar, git and SQLite.
  if (r.url().includes('/_serverFn/')) {
    const id = new URL(r.url()).pathname.split('/_serverFn/')[1]
    let fn = id
    try {
      fn = JSON.parse(Buffer.from(id, 'base64url').toString('utf8')).export.replace('_createServerFn_handler', '')
    } catch {}
    appendFileSync(
      join(out, 'server-fns.jsonl'),
      JSON.stringify({ at: new Date().toISOString(), fn, method: r.request().method(), status: r.status() }) + '\n',
    )
  }
})

const shot = async (name) => {
  const file = join(out, `${String(++shots).padStart(2, '0')}-${name}.png`)
  await page.screenshot({ path: file, fullPage: false })
  note(`screenshot ${basename(file)}`)
}
const expect = (condition, message) => {
  if (!condition) throw new Error(`expectation failed: ${message}`)
  note(`ok: ${message}`)
}

let ok = true
let failure = null
try {
  const { default: drive } = await import(pathToFileURL(script).href)
  await drive({ page, url: run.url, run, shot, note, expect })
} catch (error) {
  ok = false
  failure = error.stack ?? String(error)
  note(`FAILED: ${error.message}`)
  await page.screenshot({ path: join(out, 'failure.png') }).catch(() => {})
} finally {
  await context.tracing.stop({ path: join(out, 'trace.zip') })
  await browser.close()
}

writeFileSync(join(out, 'summary.json'), JSON.stringify({ ok, failure, script, url: run.url, evidence: out }, null, 2))
console.log(`${ok ? 'PASS' : 'FAIL'}  evidence: ${out}`)
process.exit(ok ? 0 : 1)
