import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function leaseKey(worktreePath) {
  return createHash('sha256').update(worktreePath).digest('hex').slice(0, 24);
}

export function leaseFile(stateDir, worktreePath) {
  return join(stateDir, 'leases', `${leaseKey(worktreePath)}.json`);
}

export function readLease(stateDir, worktreePath) {
  const path = leaseFile(stateDir, worktreePath);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function writeAtomic(path, value) {
  mkdirSync(join(path, '..'), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

/**
 * Acquire or refresh a lease. A live lease owned by another instance is never
 * replaced.
 */
export function acquireLease({ stateDir, worktreePath, ownerId, repository, branch, nowMs = Date.now(), ttlMs }) {
  const current = readLease(stateDir, worktreePath);
  if (current && current.expiresAt > nowMs && current.ownerId !== ownerId) {
    return { acquired: false, lease: current, reason: 'live lease belongs to another instance' };
  }
  const lease = {
    ownerId,
    repository,
    worktreePath,
    branch,
    acquiredAt: current?.ownerId === ownerId ? current.acquiredAt : nowMs,
    heartbeatAt: nowMs,
    expiresAt: nowMs + ttlMs,
  };
  writeAtomic(leaseFile(stateDir, worktreePath), lease);
  return { acquired: true, lease };
}

export function heartbeatLease({ stateDir, worktreePath, ownerId, nowMs = Date.now(), ttlMs }) {
  const current = readLease(stateDir, worktreePath);
  if (!current || current.ownerId !== ownerId) {
    return { refreshed: false, reason: 'lease is absent or owned by another instance' };
  }
  const lease = { ...current, heartbeatAt: nowMs, expiresAt: nowMs + ttlMs };
  writeAtomic(leaseFile(stateDir, worktreePath), lease);
  return { refreshed: true, lease };
}
