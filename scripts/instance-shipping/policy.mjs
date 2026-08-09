import { adoptionDecision, classifyActivity } from './activity.mjs';

/**
 * Build the next bounded action from a read-only worktree observation.
 *
 * The returned action is an instruction for the mutation layer. Keeping this
 * separate means a dry run and a real run use identical decisions.
 *
 * @param {{nowMs?: number, signals?: Array<object>, dirty?: boolean, branch?: string, defaultBranch?: boolean, owner?: boolean, ownerMode?: string, repositoryOwner?: string, configuredOwner?: string, processActive?: boolean, processCheckKnown?: boolean, ciActive?: boolean, deployActive?: boolean, conflict?: boolean, protectedBranch?: boolean}}
 * @returns {{state: string, action: string, reason: string, idleMs: number|null}}
 */
export function planWorktree(observation = {}) {
  const activity = classifyActivity({ nowMs: observation.nowMs, signals: observation.signals });
  const dirty = observation.dirty === true;

  if (activity.state === 'unknown') {
    return { state: activity.state, action: 'record-unknown', reason: 'no trustworthy live activity signal exists', idleMs: null };
  }
  if (!observation.branch || observation.branch === 'HEAD') {
    return { state: activity.state, action: 'record-held', reason: 'branch identity is unresolved', idleMs: activity.idleMs };
  }
  if (activity.state === 'active') {
    return { state: activity.state, action: 'observe', reason: 'live activity is within the active window', idleMs: activity.idleMs };
  }
  if (!dirty) {
    if (observation.owner === true) {
      return { state: activity.state, action: 'reconcile-clean', reason: 'clean worktree is eligible for bounded reconciliation by its owner', idleMs: activity.idleMs };
    }
    return { state: activity.state, action: 'record-candidate', reason: 'clean work is unowned and requires an owner before reconciliation', idleMs: activity.idleMs };
  }
  if (activity.state === 'dormant' && observation.owner === true) {
    return { state: activity.state, action: 'checkpoint-owned', reason: 'dormant dirty work has a current owner', idleMs: activity.idleMs };
  }
  if (activity.state === 'dormant') {
    return { state: activity.state, action: 'record-candidate', reason: 'dirty work is dormant but still unowned', idleMs: activity.idleMs };
  }

  const adoption = adoptionDecision({
    activityState: activity.state,
    branch: observation.branch,
    defaultBranch: observation.defaultBranch,
    ownerMode: observation.ownerMode,
    repositoryOwner: observation.repositoryOwner,
    configuredOwner: observation.configuredOwner,
    processActive: observation.processActive,
    processCheckKnown: observation.processCheckKnown,
    ciActive: observation.ciActive,
    deployActive: observation.deployActive,
    conflict: observation.conflict,
    protectedBranch: observation.protectedBranch,
  });
  return adoption.allowed
    ? { state: activity.state, action: 'adopt-and-checkpoint', reason: adoption.reason, idleMs: activity.idleMs }
    : { state: activity.state, action: 'record-held', reason: adoption.reason, idleMs: activity.idleMs };
}
