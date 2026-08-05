// Reads T-049's write ledger and writes docs/research/live-writes.md. Not
// application code — do not import from it.
//
//   node scripts/live-writes.mjs [ledger.jsonl] [out.md]
//
// The ledger is whatever `ADO_WEB_WRITE_LEDGER` named while the person used the
// app, so with that variable still set both arguments are optional.
//
// **It sends nothing.** There is no `fetch` in this file. Every byte it prints
// was sent by the app and recorded at the transport boundary (`ado-client.ts`).
//
// The comparison is against the shape the code *infers*, not against whether the
// parse threw. The failure T-040 is hunting is a 200 whose body parses cleanly
// into the wrong thing: `toComment` turns `{}` into a comment with id `0` and no
// author, and the page draws it. So each write prints the bytes that arrived, the
// shape `JSON.parse` made of them, and the difference between the two.

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

const LEDGER = process.argv[2] ?? process.env.ADO_WEB_WRITE_LEDGER
const OUT = process.argv[3] ?? 'docs/research/live-writes.md'

if (!LEDGER) {
  console.error(
    'No ledger. Pass the JSONL path as the first argument, or set ADO_WEB_WRITE_LEDGER.',
  )
  process.exit(1)
}

/**
 * The ledger already drops every string that carried the credential, so this is
 * the second line rather than the first. It stays because the report is a file
 * people paste into tickets, and a token in one is worth catching twice.
 */
async function secret() {
  if (process.env.ADO_PAT) return process.env.ADO_PAT

  try {
    const store = await import('../src/server/credentials.ts')

    return store.readAdoCredential()?.pat
  } catch (err) {
    console.error(`(credential store unreadable: ${err?.message ?? err})`)

    return undefined
  }
}

const PAT = await secret()
const redact = (s) => (PAT ? String(s ?? '').split(PAT).join('«redacted»') : String(s ?? ''))

const report = []
const say = (...lines) => report.push(...lines, '')
const table = (header, rows) => {
  report.push(`| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`, ...rows, '')
}

const fence = (value, max = 4000) => {
  let s = redact(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
  const clipped = s.length > max
  if (clipped) s = `${s.slice(0, max)}\n… [truncated, ${s.length} chars total]`

  return ['```json', s, '```']
}

const count = (n) => n.toLocaleString('en-US')
const plural = (n, word) => `${count(n)} ${word}${n === 1 ? '' : 's'}`

// --- the file ---------------------------------------------------------------

const lines = (await readFile(LEDGER, 'utf8')).split('\n')
const records = []
const unreadable = []

lines.forEach((line, index) => {
  if (line.trim() === '') return
  try {
    records.push(JSON.parse(line))
  } catch {
    // A crashed session can leave a half-written last line. Counted rather than
    // dropped, because a report that silently loses records is the wrong answer.
    unreadable.push(index + 1)
  }
})

const writes = records.filter((r) => r.kind === 'write')
const reads = records.filter((r) => r.kind === 'read')
const rereadOf = new Map(reads.map((r) => [r.afterWrite, r]))

const GUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i
const SHA = /^[0-9a-f]{40}$/i

/**
 * One section per path means per API path, not per resource: a comment posted to
 * two threads is one write path twice. Numbers, GUIDs and object ids become
 * placeholders and everything else — project names, `_apis`, stage names — is
 * left as the call site wrote it.
 */
const shapeOfPath = (path) =>
  path
    .split('/')
    .map((segment) =>
      /^\d+$/.test(segment) ? '{id}'
      : GUID.test(segment) ? '{guid}'
      : SHA.test(segment) ? '{sha}'
      : segment,
    )
    .join('/')

/**
 * What the app's own code would have to work with, four levels deep.
 *
 * Four because a thread list nests `{ count, value: [ { comments: [ … ] } ] }`,
 * and three stopped at `comments` without saying it held objects. Below four the
 * line stops being readable, so it prints a key count instead.
 */
const shapeOf = (value) => `\`${plain(value, 0)}\``

function plain(value, depth) {
  if (value === null) return 'null'
  if (Array.isArray(value)) {
    if (value.length === 0 || depth >= 4) return `array[${value.length}]`

    return `array[${value.length}] of ${plain(value[0], depth + 1)}`
  }
  if (typeof value !== 'object') return typeof value

  const keys = Object.keys(value)
  if (keys.length === 0) return '{}'
  if (depth >= 4) return `object(${keys.length} keys)`
  const shown = keys.slice(0, 24).map((key) => `${key}: ${plain(value[key], depth + 1)}`)

  return `{ ${shown.join(', ')}${keys.length > shown.length ? ', …' : ''} }`
}

const bytes = (body) =>
  body.present === false ? '_no body at all_'
  : body.chars === 0 ? '_a body, and it was empty_'
  : `${count(body.chars)} chars${body.truncated ? ' (clipped in the record)' : ''}`

/**
 * The difference between what arrived and what the code made of it. Every line
 * here is a fact about one record — nothing is inferred across records.
 */
function differences(write) {
  const body = write.body
  const out = []

  if (write.status === 0) {
    out.push(
      'No response arrived, so nothing was parsed. Note 2 makes this the ambiguous case: the write may still have been applied.',
    )
  } else if (body.present === false) {
    out.push(
      `${write.status} with no body. The caller received \`null\`, and **cannot tell this from an empty 200** — the two collapse to the same return value.`,
    )
  } else if (body.chars === 0) {
    out.push(
      `${write.status} with an empty body. The caller received \`null\`, the same value a 204 produces.`,
    )
  }

  if (write.caller === 'threw' && write.status >= 400) {
    out.push(
      `Rejected, so the caller saw an \`AdoError\` and no parse happened: ${redact(write.error ?? 'no message recorded')}.`,
    )
  }
  if (write.caller === 'threw' && write.status >= 200 && write.status < 300) {
    out.push(
      `**${write.status} whose body is not JSON.** The bytes above are what the app tried to parse: ${redact(write.error ?? 'no message recorded')}.`,
    )
  }
  if (write.caller === 'value' && write.parsed === null && body.chars > 0) {
    out.push(
      'The parse is absent from the record because the body carried the credential. The bytes are dropped for the same reason.',
    )
  }
  if (write.caller === 'value' && write.parsed !== null) {
    const keys =
      typeof write.parsed === 'object' && !Array.isArray(write.parsed)
        ? Object.keys(write.parsed)
        : null

    if (keys !== null && keys.length === 0) {
      out.push(
        '**A 200 that parses cleanly into an empty object.** This is the failure T-040 is hunting: the app’s mappers are defensive enough to turn `{}` into a comment with id `0`, no author and no content, and the page draws it.',
      )
    } else if (keys !== null) {
      out.push(
        `Parsed into ${count(keys.length)} top-level keys from ${count(body.chars)} chars. Anything the app reads and this shape does not carry becomes a mapper default, not an error.`,
      )
    }
  }

  return out.length === 0 ? ['Nothing to reconcile: the bytes and the parse agree.'] : out
}

/** A read's shape is `response.json()`, which is what `get` does with it. */
function readShape(read) {
  if (read.body.present === false) return '_no body at all_'
  if (read.body.truncated) return '_the record is clipped, so no shape can be read from it_'
  try {
    return shapeOf(JSON.parse(read.body.text))
  } catch (err) {
    return `**the app’s \`get\` would throw here** — ${redact(err?.message ?? err)}`
  }
}

// --- the report -------------------------------------------------------------

const span =
  records.length === 0
    ? 'no records'
    : `\`${records[0].at}\` to \`${records[records.length - 1].at}\``

say(
  '# Live write inventory — T-040, recorded by T-049',
  '',
  `Generated by \`scripts/live-writes.mjs\` from \`${LEDGER}\`. **Nothing here was sent by this script** — every byte was sent by the app while a person used it, and recorded at the transport boundary.`,
  '',
  `**${plural(writes.length, 'write')}** and **${count(reads.length)} correlated re-reads** across ${span}.${
    unreadable.length > 0
      ? ` ${plural(unreadable.length, 'line')} would not parse, and the end of this file says which.`
      : ''
  }`,
  '',
  'The credential is redacted, and the ledger dropped any string that contained it before this file existed. Identity GUIDs, ids and content are left in, because the app matches on them.',
  '',
  'Each write prints the bytes that arrived, the shape `JSON.parse` made of them, and the difference between the two. The comparison is against the inferred shape rather than against whether the parse threw, because a 200 that parses into the wrong thing is the failure worth finding.',
  '',
  '---',
)

if (writes.length === 0) {
  say('## No writes recorded', '', 'The ledger holds no `write` record, so there is nothing to compare.')
}

const sections = new Map()
for (const write of writes) {
  const key = `${write.method} ${shapeOfPath(write.path)}`
  if (!sections.has(key)) sections.set(key, [])
  sections.get(key).push(write)
}

if (writes.length > 0) {
  say('## Every write, one row each')
  table(
    ['#', 'path', 'status', 'caller got', 'body', 're-read'],
    writes.map((write) => {
      const reread = rereadOf.get(write.id)

      return `| ${write.id} | \`${write.method} ${shapeOfPath(write.path)}\` | ${
        write.status === 0 ? '_none_' : write.status
      } | \`${write.caller}\` | ${bytes(write.body)} | ${
        reread ? `${reread.status} (${reread.match})` : '**none**'
      } |`
    }),
  )
  say(
    `Re-reads recorded: **${count(reads.length)}** of ${count(writes.length)} writes. A write with no re-read is not a write that failed — it is a write whose "did it land" question this run does not answer.`,
  )
  say('---')
}

for (const [key, group] of [...sections].sort(([a], [b]) => a.localeCompare(b))) {
  say(`## \`${key}\``, '', `${plural(group.length, 'call')}.`)

  for (const write of group) {
    const reread = rereadOf.get(write.id)
    say(
      `### #${write.id} — ${write.status === 0 ? 'no response' : `status ${write.status}`}`,
      '',
      `\`${write.method} ${redact(write.url)}\` at \`${write.at}\``,
    )

    say('**Sent:**', '', ...(write.requestBody === null ? ['_no body_'] : fence(write.requestBody, 2000)))

    const arrived = write.body.present === false || write.body.chars === 0
    say(`**Came back:** ${bytes(write.body)}`, ...(arrived ? [] : ['', ...fence(write.body.text)]))

    say(`**The shape the code infers:** ${shapeOf(write.parsed)} — the caller got \`${write.caller}\`.`)

    say('**The difference:**', '', ...differences(write).map((line) => `- ${line}`))

    say(
      '**Did the re-read see it:**',
      '',
      ...(reread
        ? [
            `\`GET ${redact(reread.url)}\` at \`${reread.at}\` → **${reread.status}**, matched as \`${reread.match}\`, ${bytes(reread.body)}.`,
            '',
            `Inferred shape of the re-read: ${readShape(reread)}`,
          ]
        : [
            'No `GET` of this resource or its parent followed within the ledger’s window, so this write’s effect is unconfirmed here.',
          ]),
    )
    say('---')
  }
}

if (unreadable.length > 0) {
  say(
    '## Lines that would not parse',
    '',
    `${plural(unreadable.length, 'line')}: ${unreadable.map((n) => `\`${n}\``).join(', ')}. A crashed session leaves a half-written last line, which is the expected cause.`,
  )
}

await mkdir(dirname(OUT), { recursive: true })
await writeFile(OUT, `${report.join('\n')}\n`, 'utf8')

console.log(
  `Wrote ${OUT} — ${writes.length} writes, ${reads.length} re-reads, ${sections.size} path(s), ${unreadable.length} unreadable line(s).`,
)
