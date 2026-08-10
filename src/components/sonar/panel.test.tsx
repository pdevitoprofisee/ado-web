import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SonarPanel } from './panel'
import { fileAnchor } from '@/lib/file-anchor'

import type {
  GateCondition,
  RuleGroup,
  SonarFinding,
  SonarReport,
  SonarResolveResult,
  SonarRule,
} from '@/lib/sonar-contract'

// The fixtures are the census. The finding is the one open issue printed verbatim
// in §10 — `csharpsquid:S107` on `StatTrakReader.cs`, line 233, 20 minutes of
// effort — and the passing gate conditions are the four from §5, which is what
// makes "hide the passing ones" worth doing: all four read `1` against `1`.

const PATH = '/Services.Matching.Infrastructure/Stats/StatTrakReader.cs'

const finding = (over: Partial<SonarFinding> = {}): SonarFinding => ({
  key: 'AZ-pXh-nP-U4fPfm1RSA',
  rule: 'csharpsquid:S107',
  message: 'Method has 8 parameters, which is greater than the 7 authorized.',
  path: PATH,
  textRange: { startLine: 233, endLine: 235, startOffset: 55, endOffset: 94 },
  status: 'OPEN',
  impacts: [{ softwareQuality: 'MAINTAINABILITY', severity: 'MEDIUM' }],
  cleanCodeAttributeCategory: 'ADAPTABLE',
  effort: '20min',
  tags: ['brain-overload'],
  url: 'https://sonarcloud.io/project/issues?id=profisee_matching&open=AZ-pXh-nP-U4fPfm1RSA',
  // The census array minus the two this app does not offer, in wire order — §10
  // sent `["accept","confirm","resolve","falsepositive","wontfix"]`.
  transitions: ['accept', 'confirm', 'falsepositive'],
  ...over,
})

const group = (over: Partial<RuleGroup> = {}): RuleGroup => ({
  rule: 'csharpsquid:S107',
  name: 'Methods should not have too many parameters',
  severity: 'MEDIUM',
  findings: [finding()],
  ...over,
})

const passing: readonly GateCondition[] = [
  {
    metricKey: 'new_reliability_rating',
    comparator: 'GT',
    errorThreshold: '1',
    actualValue: '1',
    status: 'OK',
  },
  {
    metricKey: 'new_security_rating',
    comparator: 'GT',
    errorThreshold: '1',
    actualValue: '1',
    status: 'OK',
  },
]

const report = (over: Partial<SonarReport> = {}): SonarReport => ({
  projects: [
    {
      projectKey: 'profisee_matching',
      pullRequest: '24795',
      dashboardUrl: 'https://sonarcloud.io/dashboard?id=profisee_matching&pullRequest=24795',
    },
  ],
  groups: [group()],
  gate: { status: 'OK', conditions: passing },
  failed: [],
  truncated: [],
  ...over,
})

const rule = (over: Partial<SonarRule> = {}): SonarRule => ({
  key: 'csharpsquid:S107',
  name: 'Methods should not have too many parameters',
  language: 'cs',
  impacts: [{ softwareQuality: 'MAINTAINABILITY', severity: 'MEDIUM' }],
  cleanCodeAttribute: 'FOCUSED',
  sections: [{ key: 'root_cause', content: '<p>A long parameter list is hard to read.</p>', context: null }],
  html: null,
  tags: ['brain-overload'],
  ...over,
})

function draw(over: Partial<Parameters<typeof SonarPanel>[0]> = {}) {
  return render(
    <SonarPanel
      report={report()}
      rules={[rule()]}
      changedPaths={new Set([PATH])}
      onJump={() => {}}
      {...over}
    />,
  )
}

const panel = () => within(screen.getByRole('region', { name: 'Sonar' }))

afterEach(() => {
  vi.restoreAllMocks()
})

describe('SonarPanel', () => {
  it('renders nothing at all for a pull request with no Sonar status', () => {
    // Not an empty panel and not an error. Most pull requests in this org have no
    // Sonar project, and a permanent "no findings" heading on all of them is
    // noise above the merge banner.
    expect(draw({ report: null }).container).toBeEmptyDOMElement()
    expect(draw({ report: report({ projects: [] }) }).container).toBeEmptyDOMElement()
  })

  it('leads with the finding count and links every project’s dashboard', () => {
    draw({
      report: report({
        groups: [group(), group({ rule: 'csharpsquid:S2583', name: 'Conditions', findings: [finding({ key: 'b' })] })],
      }),
    })

    expect(screen.getByRole('heading', { name: 'Sonar, 2' })).toBeVisible()
    expect(panel().getByRole('link', { name: 'profisee_matching' })).toHaveAttribute(
      'href',
      'https://sonarcloud.io/dashboard?id=profisee_matching&pullRequest=24795',
    )
  })

  it('shows a failing gate condition with both numbers, and hides the passing ones', () => {
    draw({
      report: report({
        gate: {
          status: 'ERROR',
          conditions: [
            {
              metricKey: 'new_coverage',
              comparator: 'LT',
              errorThreshold: '80',
              actualValue: '61.2',
              status: 'ERROR',
            },
            ...passing,
          ],
        },
      }),
    })

    expect(panel().getByText('failed')).toBeVisible()

    // One row, not three: a condition that passed says nothing, and the four
    // measured on a passing gate all read `1` against `1`.
    const conditions = within(panel().getByRole('list', { name: 'Failing conditions' }))
    expect(conditions.getAllByRole('listitem')).toHaveLength(1)
    const row = conditions.getByRole('listitem')
    expect(row).toHaveTextContent('new coverage')
    expect(row).toHaveTextContent('61.2')
    expect(row).toHaveTextContent('< 80')
    expect(panel().queryByText(/new reliability rating/)).toBeNull()
  })

  it('shows no condition list at all when the gate passed', () => {
    draw()

    expect(panel().getByText('passed')).toBeVisible()
    expect(panel().queryByRole('list', { name: 'Failing conditions' })).toBeNull()
  })

  it('says the gate could not be read without costing the findings', () => {
    // The two degrade independently: a failed `qualitygates` call leaves the
    // issues list intact.
    draw({ report: report({ gate: null }) })

    expect(panel().getByText(/Could not read the quality gate/)).toBeVisible()
    expect(panel().getByRole('list', { name: 'Findings by rule' })).toBeVisible()
  })

  it('names the project whose findings were lost', () => {
    // Partial failure is the normal case for a multi-project repository, and a
    // panel that silently omits the project it lost is worse than one that says
    // which.
    draw({
      report: report({
        failed: [{ projectKey: 'profisee_connex', message: 'HTTP 403' }],
      }),
    })

    const failures = within(panel().getByRole('list', { name: 'Projects Sonar could not read' }))
    expect(failures.getByText(/profisee_connex/)).toBeVisible()
    expect(failures.getByText(/HTTP 403/)).toBeVisible()
  })

  it('says how short a truncated list is, and why it stops', () => {
    // Two different sentences on purpose. The API's ceiling is arithmetic and
    // there is nothing to do about it; a refused request means the rest of the
    // list might be there on a reload, and a reader deciding whether to trust
    // this panel needs to know which happened.
    draw({
      report: report({
        truncated: [
          { projectKey: 'profisee_matching', fetched: 10000, total: 24312, message: null },
          {
            projectKey: 'profisee_connex',
            fetched: 1500,
            total: 4000,
            message: 'SonarCloud rate-limited this token.',
          },
        ],
      }),
    })

    const short = within(
      panel().getByRole('list', { name: 'Projects with more findings than are shown' }),
    )
    expect(short.getByText(/Showing 10000 of 24312 findings for profisee_matching/)).toBeVisible()
    expect(short.getByText(/will not page past 10000/)).toBeVisible()
    expect(short.getByText(/Showing 1500 of 4000 findings for profisee_connex/)).toBeVisible()
    expect(short.getByText(/could not be read: SonarCloud rate-limited this token\./)).toBeVisible()
    // Not filed as a failure: these findings are on the screen, and the panel
    // still lists them.
    expect(panel().queryByRole('list', { name: 'Projects Sonar could not read' })).toBeNull()
    expect(panel().getByRole('list', { name: 'Findings by rule' })).toBeVisible()
  })

  it('names the count it has when Sonar sent no total at all', () => {
    draw({
      report: report({
        truncated: [
          { projectKey: 'profisee_matching', fetched: 500, total: null, message: 'HTTP 500' },
        ],
      }),
    })

    // "the first 500", not "500 of null": a count it does not have is a sentence
    // it does not write.
    expect(panel().getByText(/Showing the first 500 findings for profisee_matching/)).toBeVisible()
  })

  it('falls back to the bare rule key for a rule Sonar will not describe', () => {
    // `external_roslyn:CA1861` was requested and simply not returned —
    // externally-imported analyser rules are not in Sonar's repository. The group
    // still has findings, so hiding it would hide them.
    draw({
      report: report({
        groups: [
          group({ rule: 'external_roslyn:CA1861', name: null, severity: null, findings: [finding({ key: 'c' })] }),
        ],
      }),
      rules: [],
    })

    const groups = within(panel().getByRole('list', { name: 'Findings by rule' }))
    expect(groups.getByRole('button')).toHaveTextContent('external_roslyn:CA1861')
    // Once, not twice: the key is the title here, so it is not repeated beside it.
    expect(screen.queryByText('undefined')).toBeNull()
  })

  it('lists a group’s occurrences and its description only once opened', async () => {
    draw()

    expect(panel().queryByRole('list', { name: /occurrences/ })).toBeNull()

    const header = panel().getByRole('button', { name: /Methods should not have too many parameters/ })
    expect(header).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(header)

    expect(header).toHaveAttribute('aria-expanded', 'true')
    const occurrences = within(panel().getByRole('list', { name: /occurrences/ }))
    expect(occurrences.getByRole('listitem')).toHaveTextContent(
      'Method has 8 parameters, which is greater than the 7 authorized.',
    )
    expect(occurrences.getByRole('listitem')).toHaveTextContent('20min')

    // The rule detail rides along, sanitised, in `SECTION_ORDER`.
    expect(panel().getByText('A long parameter list is hard to read.')).toBeVisible()
  })

  it('says a repeated message once and leaves the rows as places', async () => {
    // The measured shape of `external_roslyn:IDE0058`: four findings, one
    // sentence between them. Printed per row it wrapped one word per line in a
    // column the paths had already taken.
    const repeated = 'Expression value is never used'
    draw({
      report: report({
        groups: [
          group({
            rule: 'external_roslyn:IDE0058',
            name: null,
            findings: [
              finding({ key: '1', message: repeated, effort: null }),
              finding({
                key: '2',
                message: repeated,
                effort: null,
                textRange: { startLine: 182, endLine: 182, startOffset: null, endOffset: null },
              }),
            ],
          }),
        ],
      }),
      rules: [],
    })

    // A rule Sonar will not name is titled by what its findings say, with the key
    // beside it — so the sentence is readable without expanding anything.
    const header = panel().getByRole('button', { name: new RegExp(repeated) })
    expect(header).toHaveTextContent('external_roslyn:IDE0058')
    await userEvent.click(header)

    // Once in the whole panel, and not inside either row.
    expect(panel().getAllByText(repeated)).toHaveLength(1)
    const rows = within(panel().getByRole('list', { name: /occurrences/ })).getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    for (const row of rows) expect(row).not.toHaveTextContent(repeated)
    // Each row is still the place it was, and still links out.
    expect(within(rows[0]).getByRole('button', { name: `${PATH}:233` })).toBeVisible()
    expect(within(rows[1]).getByRole('button', { name: `${PATH}:182` })).toBeVisible()
    expect(within(rows[0]).getByRole('link', { name: 'SonarCloud' })).toBeVisible()
  })

  it('keeps each message on its own row when the findings disagree', async () => {
    draw({
      report: report({
        groups: [
          group({
            findings: [
              finding({ key: '1', message: 'Method has 8 parameters' }),
              finding({ key: '2', message: 'Method has 9 parameters' }),
            ],
          }),
        ],
      }),
    })

    await userEvent.click(panel().getByRole('button', { name: /Methods should not/ }))

    const rows = within(panel().getByRole('list', { name: /occurrences/ })).getAllByRole('listitem')
    expect(rows[0]).toHaveTextContent('Method has 8 parameters')
    expect(rows[1]).toHaveTextContent('Method has 9 parameters')
  })

  it('says so when Sonar has no description for the rule that fired', async () => {
    draw({ rules: [] })

    await userEvent.click(panel().getByRole('button', { name: /Methods should not/ }))

    expect(panel().getByText(/Rules imported from another analyser/)).toBeVisible()
  })

  it('jumps on a file:line that is in the diff, anchored on textRange.startLine', async () => {
    // 233 is `textRange.startLine`. Never `line`, which was absent on all 3 fixed
    // issues while `textRange` was present on all of them.
    const jump = vi.fn()
    draw({ onJump: jump })

    await userEvent.click(panel().getByRole('button', { name: /Methods should not/ }))
    await userEvent.click(panel().getByRole('button', { name: `${PATH}:233` }))

    expect(jump).toHaveBeenCalledWith({ path: PATH, line: 233 })
  })

  it('moves the page to the file’s panel when nothing overrides the jump', async () => {
    // The default handler, through the id `changed-file.tsx` puts on each panel —
    // the same scheme the file tree uses.
    const target = document.createElement('div')
    target.id = fileAnchor(PATH)
    document.body.append(target)
    const scroll = vi.fn()
    target.scrollIntoView = scroll

    draw({ onJump: undefined })
    await userEvent.click(panel().getByRole('button', { name: /Methods should not/ }))
    await userEvent.click(panel().getByRole('button', { name: `${PATH}:233` }))

    expect(scroll).toHaveBeenCalledWith({ block: 'start' })
    target.remove()
  })

  it('refuses to offer a jump to a file this pull request did not change', async () => {
    // Sonar analysed a path the diff does not hold, or the line drifted after the
    // last push (note 6). Either way there is no panel to scroll to.
    draw({ changedPaths: new Set() })

    await userEvent.click(panel().getByRole('button', { name: /Methods should not/ }))

    const row = within(panel().getByRole('list', { name: /occurrences/ })).getByRole('listitem')
    expect(row).toHaveTextContent('not in this diff')
    expect(panel().queryByRole('button', { name: `${PATH}:233` })).toBeNull()
    // Still there, still readable: the finding is not dropped for being
    // unreachable.
    expect(row).toHaveTextContent(PATH)
  })

  it('renders a finding with no file rather than dropping it', async () => {
    // A project-level issue. None were sampled, but the contract allows `null`
    // and a panel that assumes a path crashes on the first one.
    draw({
      report: report({
        groups: [
          group({
            findings: [
              finding({ key: 'project-level', path: null, textRange: null, effort: null }),
            ],
          }),
        ],
      }),
    })

    await userEvent.click(panel().getByRole('button', { name: /Methods should not/ }))

    const row = within(panel().getByRole('list', { name: /occurrences/ })).getByRole('listitem')
    expect(row).toHaveTextContent('project-level')
    expect(row).toHaveTextContent('Method has 8 parameters')
    expect(row).not.toHaveTextContent('null')
  })

  it('says the analysis was clean rather than showing an empty list', () => {
    draw({ report: report({ groups: [] }) })

    expect(panel().getByText(/No open findings/)).toBeVisible()
    expect(panel().queryByRole('list', { name: 'Findings by rule' })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Triage.
// ---------------------------------------------------------------------------

const landed = (over: Partial<SonarResolveResult> = {}): SonarResolveResult => ({
  transitioned: true,
  status: 'ACCEPTED',
  thread: 'updated',
  error: null,
  threadError: null,
  ...over,
})

/** Opens the one group and answers with its single row. */
async function row(over: Partial<Parameters<typeof SonarPanel>[0]> = {}) {
  draw(over)
  await userEvent.click(panel().getByRole('button', { name: /Methods should not/ }))

  return within(within(panel().getByRole('list', { name: /occurrences/ })).getByRole('listitem'))
}

describe('triaging a finding', () => {
  it('draws no triage button on a panel that was given no way to write', async () => {
    const only = await row()

    expect(only.queryByRole('button', { name: 'Accept' })).toBeNull()
    expect(only.getByRole('link', { name: 'SonarCloud' })).toBeVisible()
  })

  it('offers exactly the transitions Sonar offered for this issue', async () => {
    const only = await row({ actions: { onResolve: vi.fn() } })

    expect(only.getByRole('button', { name: 'Accept' })).toBeVisible()
    expect(only.getByRole('button', { name: 'False positive' })).toBeVisible()
    expect(only.getByRole('button', { name: 'Confirm' })).toBeVisible()
    // Sonar drops a transition it will refuse, and the issue in the census is
    // open, so `reopen` was not in its array. A button from a fixed list would
    // offer a write the API answers 400 to.
    expect(only.queryByRole('button', { name: 'Reopen' })).toBeNull()
  })

  it('draws nothing at all when the token may not triage', async () => {
    // §10's other sampled issue: `transitions: []`, `actions: ["comment"]`. This is
    // also every issue for a token without Administer Issues.
    const only = await row({
      actions: { onResolve: vi.fn() },
      report: report({ groups: [group({ findings: [finding({ transitions: [] })] })] }),
    })

    expect(only.queryAllByRole('button', { name: /Accept|False positive|Confirm|Reopen/ })).toEqual([])
    expect(only.getByRole('link', { name: 'SonarCloud' })).toBeVisible()
  })

  it('sends the issue key and the transition, and nothing else', async () => {
    const onResolve = vi.fn().mockResolvedValue(landed())
    const only = await row({ actions: { onResolve } })

    await userEvent.click(only.getByRole('button', { name: 'False positive' }))

    expect(onResolve).toHaveBeenCalledWith({
      issueKey: 'AZ-pXh-nP-U4fPfm1RSA',
      transition: 'falsepositive',
    })
  })

  it('holds every button on the row while the write is out', async () => {
    let settle: (result: SonarResolveResult) => void = () => {}
    const onResolve = vi.fn(
      () => new Promise<SonarResolveResult>((resolve) => (settle = resolve)),
    )
    const only = await row({ actions: { onResolve } })

    await userEvent.click(only.getByRole('button', { name: 'Accept' }))

    // Said on the button that was pressed, so the row states which write is out
    // rather than going quiet. The others are held because they are alternatives
    // to it — a second transition sent while the first is in flight would be a
    // race whose winner decides the issue's state.
    expect(only.getByRole('button', { name: 'Saving…' })).toBeDisabled()
    expect(only.getByRole('button', { name: 'Confirm' })).toBeDisabled()

    await act(async () => settle(landed()))

    expect(only.getByRole('button', { name: 'Accept' })).toBeEnabled()
  })

  it('says why Sonar refused, and does not pretend the finding moved', async () => {
    const onResolve = vi.fn().mockResolvedValue({
      transitioned: false,
      status: null,
      thread: 'none',
      error: 'SonarCloud answered 403.',
      threadError: null,
    })
    const only = await row({ actions: { onResolve } })

    await userEvent.click(only.getByRole('button', { name: 'Accept' }))

    expect(await only.findByRole('alert')).toHaveTextContent('SonarCloud answered 403.')
  })

  it('reports a call that never arrived as a failure of the row', async () => {
    const onResolve = vi.fn().mockRejectedValue(new Error('Failed to fetch'))
    const only = await row({ actions: { onResolve } })

    await userEvent.click(only.getByRole('button', { name: 'Accept' }))

    expect(await only.findByRole('alert')).toHaveTextContent('Failed to fetch')
    // The button comes back, because nothing is known to have happened.
    expect(only.getByRole('button', { name: 'Accept' })).toBeEnabled()
  })

  it('names the half that is outstanding when the comment could not be closed', async () => {
    const onResolve = vi
      .fn()
      .mockResolvedValue(landed({ thread: 'failed', threadError: 'Azure DevOps answered 409.' }))
    const only = await row({ actions: { onResolve } })

    await userEvent.click(only.getByRole('button', { name: 'Accept' }))

    // Two services, and the triage is the one that mattered. Sending the reader
    // back to do the whole thing again would be telling them to transition an
    // issue Sonar has already accepted.
    const said = await only.findByRole('alert')
    expect(said).toHaveTextContent('SonarCloud is updated.')
    expect(said).toHaveTextContent('Azure DevOps answered 409.')
    expect(said).not.toHaveClass('text-destructive')
  })

  it('says nothing at all when both halves landed', async () => {
    const onResolve = vi.fn().mockResolvedValue(landed())
    const only = await row({ actions: { onResolve } })

    await userEvent.click(only.getByRole('button', { name: 'Accept' }))

    expect(only.queryByRole('alert')).toBeNull()
  })

  it.each([
    ['ACCEPTED', 'accepted'],
    ['CONFIRMED', 'confirmed'],
  ] as const)('marks a %s finding, which stays in this list', async (status, said) => {
    // `issueStatuses` asks for `OPEN,CONFIRMED,ACCEPTED`, so a finding somebody
    // accepted stays in this list. Unmarked, it is identical to an untouched one
    // and the button that moved it reads as broken.
    const only = await row({
      report: report({ groups: [group({ findings: [finding({ status })] })] }),
    })

    expect(only.getByText(said)).toBeVisible()
  })

  it('marks nothing on an open finding, which is what every row here is', async () => {
    const only = await row()

    expect(only.queryByText(/accepted|confirmed/)).toBeNull()
  })
})
