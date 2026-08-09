/**
 * pr-reviewer-triage.mjs, route a pull request to the approved QA surfaces.
 *
 * Built on the same "classify signals → routing decision" substrate as the
 * privacy gate. The default path is deliberately free and local:
 *   - local-gates       = repository tests, linters, type checks, and static checks.
 *   - local-review-skill = a local two-axis review skill when a second perspective is useful.
 *   - CodeRabbit         = manual fallback only, with a flat-rate billing
 *                          confirmation and a bounded approval.
 *   - every other hosted reviewer = blocked by default.
 *
 * A hosted-review result never replaces local gates or the human merge decision.
 *
 * Pure, synchronous, dependency-free.
 */

export const REVIEWER = Object.freeze({
  LOCAL_GATES: 'local-gates',
  LOCAL_REVIEW_SKILL: 'local-review-skill',
  CODERABBIT: 'coderabbit',
  GREPTILE: 'greptile',
  QODO: 'qodo',
});

const HOSTED_FALLBACKS = new Set([REVIEWER.CODERABBIT]);
const BLOCKED_HOSTED_REVIEWERS = new Set([REVIEWER.GREPTILE, REVIEWER.QODO]);
const CODERABBIT_FALLBACK_DEADLINE = '2026-09-08';
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isIsoCalendarDate(value) {
  if (!ISO_DATE.test(value || '')) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime())
    && parsed.toISOString().slice(0, 10) === value;
}

export const REPO_TIER = Object.freeze({
  STANDARD: 'standard',       // local gates and local review skill
  COMPLEX: 'complex',         // local gates and local review skill
  PRODUCTION: 'production',   // local gates and local review skill
});

/**
 * triagePr(pr, opts), decide the reviewer set for a PR.
 *
 * @param {object} pr
 * @param {string} [pr.repoTier]     'standard' | 'complex' | 'production'
 * @param {number} [pr.filesChanged]
 * @param {number} [pr.linesChanged] additions + deletions
 * @param {string[]} [pr.riskLabels] e.g. ['security', 'breaking', 'release']
 * @param {string[]} [pr.pathsTouched]
 * @param {boolean} [pr.isReleaseOrMigration]
 * @param {object} [opts]
 * @param {string} [opts.currentDate] ISO date override for deterministic tests
 * @returns {{reviewers:string[], rationale:string[], mergeGate:string|null}}
 */
export function triagePr(pr = {}, opts = {}) {
  const rationale = [];
  const reviewers = new Set([REVIEWER.LOCAL_GATES, REVIEWER.LOCAL_REVIEW_SKILL]);
  rationale.push('Free-first default: local gates plus the local review skill.');

  const requestedReviewers = Array.isArray(opts.paidReviewers)
    ? [...new Set(opts.paidReviewers.map(String))]
    : [];
  const approval = opts.hostedApproval || {};
  const currentDate = opts.currentDate || new Date().toISOString().slice(0, 10);
  const approvalDateIsBounded = isIsoCalendarDate(currentDate)
    && isIsoCalendarDate(approval.approvedUntil)
    && approval.approvedUntil >= currentDate
    && approval.approvedUntil <= CODERABBIT_FALLBACK_DEADLINE;
  const approvalIsBounded = opts.allowPaidReviewers === true
    && approval.automatic === false
    && approval.billingMode === 'flat-rate'
    && typeof approval.provider === 'string'
    && approval.maxReviews === 1
    && approvalDateIsBounded;
  const requestedPaidReviewers = requestedReviewers.filter(name => HOSTED_FALLBACKS.has(name));
  const paidReviewers = approvalIsBounded
    ? requestedPaidReviewers.filter(name => name === approval.provider).slice(0, 1)
    : [];

  if (requestedReviewers.some(name => BLOCKED_HOSTED_REVIEWERS.has(name))) {
    rationale.push('Safety guard: Greptile and Qodo are blocked and cannot be routed.');
  }
  if (requestedReviewers.length && paidReviewers.length === 0 && !requestedReviewers.some(name => BLOCKED_HOSTED_REVIEWERS.has(name))) {
    rationale.push('Cost guard: hosted review requires bounded manual approval and confirmed flat-rate billing, so none were added.');
  }
  if (requestedPaidReviewers.length > paidReviewers.length && paidReviewers.length > 0) {
    rationale.push('Cost guard: capped paid review to one explicitly named reviewer.');
  }

  if (paidReviewers.includes(REVIEWER.CODERABBIT)) {
    reviewers.add(REVIEWER.CODERABBIT);
    rationale.push(`CodeRabbit: bounded manual fallback approved through ${approval.approvedUntil}.`);
  }

  return { reviewers: [...reviewers], rationale, mergeGate: null };
}
