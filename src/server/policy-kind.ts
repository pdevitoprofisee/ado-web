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

/** The one settings key that says "a build ran". */
export interface BuildPolicySettings {
  readonly buildDefinitionId?: number
}

/**
 * Whether a build, and not anything else, satisfies this policy.
 *
 * Keyed off `buildDefinitionId` for {@link waitsOnPeople}'s reason: `displayName`
 * is the definition's name, which is display text somebody can rename, and
 * `type.displayName` is the word "Build" on every build policy and also collides
 * with the other types. The id is data.
 *
 * This is what lets a failed check say *which* failed. ADO reports a rejected
 * reviewer and a broken build under one status pair (`rejected`, `broken`), and
 * the two are opposite instructions: one is somebody to go and talk to, the other
 * is a pipeline to go and read.
 */
export const isBuild = (settings: BuildPolicySettings | undefined): boolean =>
  typeof settings?.buildDefinitionId === 'number'

/** The one settings key that says "a squash is allowed". */
export interface MergeStrategyPolicySettings {
  readonly allowSquash?: boolean
}

/**
 * Whether the squash this app sends already satisfies this policy.
 *
 * A "Require a merge strategy" policy rejects the merge Azure DevOps *previewed*,
 * and until somebody sets `completionOptions.mergeStrategy` that preview is a
 * merge commit. So a squash-only policy sits at `rejected` on every pull request
 * in the repository, and nothing clears it except the merge itself. Measured on
 * `Products/dev-launchpad`: three active pull requests with no strategy set, all
 * three `rejected`; the one that completed with `squash` was `approved`.
 *
 * Treated as unsatisfied, that row is a deadlock — `completePullRequest` sends
 * `mergeStrategy: 'squash'` and nothing else, so the button that would clear the
 * policy is the button the policy switches off.
 *
 * Keyed off `allowSquash` alone, which is both the test for "this is a merge
 * strategy policy" and the answer. An absent or `false` key claims nothing and
 * leaves the row blocking, which is the safe direction: a policy that forbids
 * squashing really does stand between this app and a merge.
 */
export const clearedBySquash = (settings: MergeStrategyPolicySettings | undefined): boolean =>
  settings?.allowSquash === true
