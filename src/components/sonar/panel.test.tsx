import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SonarPanel } from './panel'
import { fileAnchor } from '@/lib/file-anchor'

import type {
  GateCondition,
  RuleGroup,
  SonarFinding,
  SonarReport,
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
