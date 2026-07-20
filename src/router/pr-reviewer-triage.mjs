/**
 * pr-reviewer-triage.mjs, route a pull request to the optimal AI reviewer(s).
 *
 * Built on the same "classify signals → routing decision" substrate as the
 * privacy gate. Encodes the stack-ops Run-1 QA tiering (decision G):
 *   - CodeRabbit = the ALWAYS-ON default reviewer on every PR (lowest noise,
 *     diff-only). Never removed by the triage.
 *   - Greptile   = ADD on complex/critical repos or large/cross-cutting diffs
 *     (full-codebase semantic index; higher bug-catch, higher false-positive load).
 *   - Qodo       = ADD as a merge-gate on production-critical repos, only when the
 *     PR is genuinely high-stakes (touches critical paths, carries a risk label,
 *     or is a release/migration).
 *
 * Anti-pattern guard (decision G): NEVER run all three bots on a trivial PR, and
 * never let "AI found no issues" be the only required check, that's a human/CI
 * concern the caller enforces; this module only decides which bots to invoke.
 *
 * Pure, synchronous, dependency-free.
 */

export const REVIEWER = Object.freeze({
  CODERABBIT: 'coderabbit',
  GREPTILE: 'greptile',
  QODO: 'qodo',
});

export const REPO_TIER = Object.freeze({
  STANDARD: 'standard',       // CodeRabbit only, unless the diff is large/cross-cutting
  COMPLEX: 'complex',         // + Greptile
  PRODUCTION: 'production',   // + Greptile, + Qodo as a merge-gate on high-stakes PRs
});

// A diff at/above either threshold counts as "large" and pulls in Greptile even on
// a standard repo (broad blast radius benefits from a full-codebase semantic pass).
const LARGE_DIFF_LINES = 400;
const LARGE_DIFF_FILES = 15;

// Default "critical path" fragments, override via opts.criticalPaths.
const DEFAULT_CRITICAL_PATHS = [
  /(?:^|\/)(?:auth|payment|billing|security|crypto|migrations?)\b/i,
  /(?:^|\/)lib\/council\.mjs$/i,   // the research/router engine
  /\.github\/workflows\//i,        // CI definitions
  /(?:^|\/)(?:Dockerfile|docker-compose|infra|terraform)\b/i,
];

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
 * @param {RegExp[]} [opts.criticalPaths]
 * @returns {{reviewers:string[], rationale:string[], mergeGate:string|null}}
 */
export function triagePr(pr = {}, opts = {}) {
  const rationale = [];
  const reviewers = new Set([REVIEWER.CODERABBIT]);
  rationale.push('CodeRabbit: always-on default reviewer (every PR).');

  const tier = pr.repoTier || REPO_TIER.STANDARD;
  const files = Number(pr.filesChanged) || 0;
  const lines = Number(pr.linesChanged) || 0;
  const labels = (pr.riskLabels || []).map(String);
  const paths = (pr.pathsTouched || []).map(String);
  const critical = opts.criticalPaths || DEFAULT_CRITICAL_PATHS;

  const largeDiff = lines >= LARGE_DIFF_LINES || files >= LARGE_DIFF_FILES;
  const touchesCritical = paths.some(p => critical.some(re => re.test(p)));
  const hasRiskLabel = labels.some(l => /security|breaking|release|migration|data|critical/i.test(l));
  const highStakes = touchesCritical || hasRiskLabel || !!pr.isReleaseOrMigration;

  // Greptile: complex/production repos, OR large/cross-cutting diffs on any repo.
  if (tier === REPO_TIER.COMPLEX || tier === REPO_TIER.PRODUCTION) {
    reviewers.add(REVIEWER.GREPTILE);
    rationale.push(`Greptile: repo tier "${tier}" → add full-codebase semantic review.`);
  } else if (largeDiff) {
    reviewers.add(REVIEWER.GREPTILE);
    rationale.push(`Greptile: large/cross-cutting diff (${lines} lines / ${files} files) → semantic pass warranted.`);
  }

  // Qodo: merge-gate on production-critical repos, only when the PR is high-stakes.
  let mergeGate = null;
  if (tier === REPO_TIER.PRODUCTION && highStakes) {
    reviewers.add(REVIEWER.QODO);
    mergeGate = REVIEWER.QODO;
    const why = [
      touchesCritical && 'touches a critical path',
      hasRiskLabel && `risk label (${labels.join(', ')})`,
      pr.isReleaseOrMigration && 'release/migration',
    ].filter(Boolean).join('; ');
    rationale.push(`Qodo: production repo + high-stakes (${why}) → add as a merge-gate.`);
  }

  // Anti-pattern guard: never three bots on a small, low-risk PR.
  if (reviewers.size === 3 && !highStakes && !largeDiff) {
    reviewers.delete(REVIEWER.QODO);
    mergeGate = null;
    rationale.push('Guard: dropped Qodo, three bots on a small, low-risk PR is the noise anti-pattern.');
  }

  return { reviewers: [...reviewers], rationale, mergeGate };
}
