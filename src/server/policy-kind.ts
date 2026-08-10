// Server-only, and one function long. What kind of thing satisfies a policy.
//
// It is its own module because **two callers must not disagree**: the inbox badge
// (`hydrate.ts`) and the detail page's checklist (`pull-request.ts`) both split
// the unmet policies into the ones a person clears and the ones a machine
// clears, and a row that counted as a reviewer in one place and a build in the
// other would be a badge that contradicts the page it links to.

/**
 * The two settings keys that say "people". Structurally satisfied by
 * `pull-request.ts`'s `AdoPolicySettings` and by `hydrate.ts`'s narrower view of
 * the same object, so neither has to import the other's shape.
 */
export interface ReviewerPolicySettings {
  readonly minimumApproverCount?: number
  readonly requiredReviewerIds?: readonly string[]
}

/**
 * Whether people, and not a machine, satisfy this policy.
 *
 * Keyed off the settings and not off `type.displayName`, for `policyDetail`'s
 * reason: the name is display text and collides, the settings are data and do
 * not. Either key counts — a "Required reviewers" policy carries `both`
 * (measured, 10 of 10) and a "Minimum number of reviewers" policy carries only
 * the count.
 */
export const waitsOnPeople = (settings: ReviewerPolicySettings | undefined): boolean =>
  settings?.requiredReviewerIds !== undefined || typeof settings?.minimumApproverCount === 'number'
