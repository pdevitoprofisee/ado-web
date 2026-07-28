import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { RuleDetail, orderSections } from './rule-detail'

import type { RuleSection, SonarRule } from '@/lib/sonar-contract'

// The ordering is the test. `javascript:S4036` came back twice in one probe run
// with its four sections in two different orders, so a renderer that trusts the
// response reads differently depending on which call filled the cache.

const section = (key: string, content = `<p>${key}</p>`): RuleSection => ({
  key,
  content,
  context: null,
})

const rule = (over: Partial<SonarRule> = {}): SonarRule => ({
  key: 'javascript:S4036',
  name: 'Searching OS commands in PATH is security-sensitive',
  language: 'js',
  impacts: [{ softwareQuality: 'SECURITY', severity: 'LOW' }],
  cleanCodeAttribute: 'COMPLETE',
  sections: [],
  html: null,
  tags: ['cwe'],
  ...over,
})

/** The section headings, in the order they are on the page. */
const headings = () => screen.getAllByRole('heading', { level: 4 }).map((node) => node.textContent)

describe('orderSections', () => {
  it('imposes SECTION_ORDER on the order the API happened to answer in', () => {
    // Both orders are real: this is the same rule, twice, in one run.
    const first = ['root_cause', 'how_to_fix', 'resources', 'introduction'].map((key) =>
      section(key),
    )
    const second = ['resources', 'introduction', 'root_cause', 'how_to_fix'].map((key) =>
      section(key),
    )
    const expected = ['introduction', 'root_cause', 'how_to_fix', 'resources']

    expect(orderSections(first).map((entry) => entry.key)).toEqual(expected)
    expect(orderSections(second).map((entry) => entry.key)).toEqual(expected)
  })

  it('sorts a key it has never heard of to the end instead of dropping it', () => {
    // A section key the API invents later is content we cannot place, not content
    // to hide. Several of them keep the order they arrived in, because the sort
    // is stable.
    const ordered = orderSections([
      section('what_next'),
      section('resources'),
      section('how_to_fix'),
      section('and_another'),
    ])

    expect(ordered.map((entry) => entry.key)).toEqual([
      'how_to_fix',
      'resources',
      'what_next',
      'and_another',
    ])
  })
})

describe('RuleDetail', () => {
  it('reads in SECTION_ORDER regardless of what order it was handed', () => {
    render(
      <RuleDetail
        rule={rule({
          sections: ['resources', 'made_up_section', 'introduction', 'root_cause'].map((key) =>
            section(key),
          ),
        })}
      />,
    )

    // Sonar's own words for the four keys it knows, and the raw key for the one
    // it does not — last, and present.
    expect(headings()).toEqual([
      'Introduction',
      'Why is this an issue?',
      'Resources',
      'made_up_section',
    ])
    expect(screen.getByRole('heading', { level: 4, name: 'made_up_section' })).toBeVisible()
  })

  it('renders each section’s HTML as markup', () => {
    render(
      <RuleDetail
        rule={rule({
          sections: [section('how_to_fix', '<pre><code>spawn("/usr/bin/ls")</code></pre>')],
        })}
      />,
    )

    expect(screen.getByRole('heading', { level: 4, name: 'How can I fix it?' })).toBeVisible()
    expect(screen.getByText('spawn("/usr/bin/ls")').closest('pre')).not.toBeNull()
  })

  it('names the framework a contextual section is about', () => {
    // One rule described once per framework arrives as several sections that
    // share a key and differ only by `context`.
    render(
      <RuleDetail
        rule={rule({
          sections: [
            { ...section('how_to_fix'), context: { key: 'node', displayName: 'Node.js' } },
            { ...section('how_to_fix'), context: { key: 'browser', displayName: 'Browser' } },
          ],
        })}
      />,
    )

    expect(headings()).toEqual(['How can I fix it? — Node.js', 'How can I fix it? — Browser'])
  })

  it('falls back to the single description blob when there are no sections', () => {
    render(<RuleDetail rule={rule({ html: '<p>the whole thing</p>' })} />)

    expect(screen.getByText('the whole thing')).toBeVisible()
    expect(screen.queryAllByRole('heading', { level: 4 })).toEqual([])
  })

  it('says so when Sonar described the rule with nothing at all', () => {
    render(<RuleDetail rule={rule()} />)

    expect(screen.getByText('Sonar returned no description for this rule.')).toBeVisible()
  })
})
