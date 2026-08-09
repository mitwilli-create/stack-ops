/**
 * Activity state for repository and worktree coordination.
 *
 * This module is deliberately pure. The observer gathers signals, then passes
 * them here so the 45-minute and 6-hour decisions can be tested exactly.
 */

export const DORMANT_AFTER_MS = 45 * 60 * 1000;
export const ABANDONED_AFTER_MS = 6 * 60 * 60 * 1000;

function timestampMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return NaN;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

/**
 * Normalize and retain live signals only. A stale process may be reported for
 * diagnostics, but it must not keep a worktree active.
 *
 * @param {Array<{kind?: string, at?: string|number, live?: boolean, detail?: string}>} signals
 * @returns {Array<{kind: string, at: number, live: boolean, detail?: string}>}
 */
export function normalizeSignals(signals = []) {
  return signals
    .map((signal) => ({
      kind: typeof signal?.kind === 'string' ? signal.kind : 'unknown',
      at: timestampMs(signal?.at),
      live: signal?.live !== false,
      ...(typeof signal?.detail === 'string' ? { detail: signal.detail } : {}),
    }))
    .filter((signal) => Number.isFinite(signal.at));
}

/**
 * @param {{nowMs?: number, signals?: Array<object>}} input
 * @returns {{state: 'active'|'dormant'|'abandoned'|'unknown', idleMs: number|null, latestAt: number|null, signals: Array<object>}}
 */
export function classifyActivity({ nowMs = Date.now(), signals = [] } = {}) {
  const normalized = normalizeSignals(signals);
  const liveSignals = normalized.filter((signal) => signal.live && signal.at <= nowMs);
  const latestAt = liveSignals.reduce(
    (latest, signal) => Math.max(latest, signal.at),
    Number.NEGATIVE_INFINITY,
  );

  if (!Number.isFinite(latestAt)) {
    return { state: 'unknown', idleMs: null, latestAt: null, signals: normalized };
  }

  const idleMs = Math.max(0, nowMs - latestAt);
  const state = idleMs >= ABANDONED_AFTER_MS
    ? 'abandoned'
    : idleMs >= DORMANT_AFTER_MS
      ? 'dormant'
      : 'active';

  return { state, idleMs, latestAt, signals: normalized };
}

/**
 * Determine whether abandoned work can be adopted without stepping on a live
 * process or hosted operation.
 *
 * @param {{activityState: string, branch: string, defaultBranch?: boolean, ownerMode?: string, repositoryOwner?: string, configuredOwner?: string, processActive?: boolean, processCheckKnown?: boolean, ciActive?: boolean, deployActive?: boolean, conflict?: boolean, protectedBranch?: boolean}}
 * @returns {{allowed: boolean, reason: string}}
 */
export function adoptionDecision({
  activityState,
  branch,
  defaultBranch = false,
  ownerMode = 'unknown',
  repositoryOwner,
  configuredOwner,
  processActive = false,
  processCheckKnown = true,
  ciActive = false,
  deployActive = false,
  conflict = false,
  protectedBranch = false,
} = {}) {
  if (activityState !== 'abandoned') {
    return { allowed: false, reason: `activity state is ${activityState}, not abandoned` };
  }
  if (!processCheckKnown) return { allowed: false, reason: 'local process liveness could not be verified' };
  if (processActive) return { allowed: false, reason: 'a live local process still owns the worktree' };
  if (ciActive) return { allowed: false, reason: 'continuous integration is active for the branch' };
  if (deployActive) return { allowed: false, reason: 'deployment is active for the branch' };
  if (conflict) return { allowed: false, reason: 'worktree or branch has an unresolved conflict' };
  if (protectedBranch) return { allowed: false, reason: 'branch is protected from automated mutation' };
  if (!branch || branch === 'HEAD') return { allowed: false, reason: 'branch identity is unresolved' };
  if (ownerMode !== 'solo') return { allowed: false, reason: 'solo-owner adoption is not enabled' };
  if (!configuredOwner || !repositoryOwner || configuredOwner !== repositoryOwner) {
    return { allowed: false, reason: 'configured owner does not match repository owner' };
  }
  return {
    allowed: true,
    reason: defaultBranch
      ? 'abandoned default branch may be copied to an agent-owned feature branch'
      : 'abandoned feature branch may be adopted by the configured solo owner',
  };
}
