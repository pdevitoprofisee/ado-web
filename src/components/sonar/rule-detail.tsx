import { RuleHtml } from './rule-html'
import { SECTION_ORDER } from '@/lib/sonar-contract'

import type { RuleSection, SonarRule } from '@/lib/sonar-contract'

// What a rule says, in an order the API does not supply.

/**
 * Sonar's own words for each section, so the headings read like the rule pages
 * people already know.
 *
 * A key that is not in here is not dropped — it renders under its raw key. The
 * `rules` API has added and renamed section keys before (`type` disappeared from
 * the field list altogether), and a renderer that only knows five keys should
 * degrade to showing the sixth badly rather than hiding it.
 */
const SECTION_TITLES: Record<string, string> = {
  introduction: 'Introduction',
  root_cause: 'Why is this an issue?',
  assess_the_problem: 'Assess the risk',
  how_to_fix: 'How can I fix it?',
  resources: 'Resources',
}

/**
 * The sections of a rule, in reading order.
 *
 * **The order has to be imposed, because the API's is not stable.** Measured:
 * `javascript:S4036` twice in one probe run answered
 * `root_cause, how_to_fix, resources, introduction` and then
 * `resources, introduction, root_cause, how_to_fix`. Without this the same rule
 * reads differently depending on which call filled the cache, which looks like a
 * rendering bug and is not one.
 *
 * An unrecognised key sorts to the end rather than being dropped, and the sort is
 * stable — so several unknown keys keep the order they arrived in, and the
 * contextual sections that share one key (a rule described once per framework)
 * stay grouped and in sequence.
 */
export function orderSections(sections: readonly RuleSection[]): readonly RuleSection[] {
  const rank = (key: string) => {
    const at = SECTION_ORDER.indexOf(key)

    return at === -1 ? SECTION_ORDER.length : at
  }

  return [...sections].sort((left, right) => rank(left.key) - rank(right.key))
}

/** The heading a section reads under, carrying its framework when it has one. */
function sectionTitle(section: RuleSection): string {
  const title = SECTION_TITLES[section.key] ?? section.key

  return section.context === null ? title : `${title} — ${section.context.displayName}`
}

/**
 * A rule, described.
 *
 * Sections when there are any and the single `html` blob when there are not:
 * `descriptionSections` was present on 3 of 3 rules measured, but a rule with
 * only `htmlDesc` is a shape the contract allows and the fallback costs one
 * branch.
 */
export function RuleDetail({ rule }: { rule: SonarRule }) {
  const sections = orderSections(rule.sections)

  return (
    <div aria-label={`Rule ${rule.key}`} className="w-full">
      {sections.length > 0 ? (
        sections.map((section, index) => (
          // Indexed key because a key can legitimately repeat: one rule
          // described once per framework arrives as several `how_to_fix`
          // sections distinguished only by `context`.
          <div key={`${section.key}-${section.context?.key ?? index}`} className="mb-3 last:mb-0">
            <h4 className="text-muted-foreground mb-1 text-xs font-medium tracking-wide uppercase">
              {sectionTitle(section)}
            </h4>
            <RuleHtml>{section.content}</RuleHtml>
          </div>
        ))
      ) : rule.html !== null ? (
        <RuleHtml>{rule.html}</RuleHtml>
      ) : (
        <p className="text-muted-foreground text-sm">
          Sonar returned no description for this rule.
        </p>
      )}
    </div>
  )
}
