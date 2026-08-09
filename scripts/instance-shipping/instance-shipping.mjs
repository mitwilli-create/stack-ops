#!/usr/bin/env node

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { classifyActivity } from './activity.mjs';
import {
  checkpointWorktree,
  createFeatureBranch,
  listChangedPaths,
  currentBranch,
  defaultBranch,
  pushFeatureBranch,
  reconcileCleanBranch,
  runGit,
} from './git-actions.mjs';
import { draftPullRequestArgs } from './git-actions.mjs';
import { leaseKey, readLease, acquireLease } from './leases.mjs';
import { planWorktree } from './policy.mjs';
import { writeReceipt } from './receipts.mjs';
import { loadDeployManifest, runDeployment } from './deploy.mjs';

const SCRIPT_DIR = new URL('.', import.meta.url).pathname;
const DEFAULT_CONFIG = join(SCRIPT_DIR, 'config.json');

function parseArgs(argv) {
  const args = new Set(argv);
  const value = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  return {
    dryRun: args.has('--dry-run') || !args.has('--apply'),
    once: args.has('--once') || args.has('--dry-run') || args.has('--apply'),
    heartbeat: args.has('--heartbeat'),
    worktree: value('--worktree'),
    instanceId: value('--instance') || process.env.STACK_OPS_INSTANCE_ID || `instance-shipping-${process.pid}`,
    configPath: value('--config') || DEFAULT_CONFIG,
    status: args.has('--status'),
  };
}

function loadConfig(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function atomicJson(path, value) {
  mkdirSync(join(path, '..'), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

function heartbeatPath(config, worktree) {
  return join(config.stateDir, 'heartbeats', `${leaseKey(worktree)}-${process.pid}.json`);
}

function recordHeartbeat(config, worktree, instanceId, nowMs = Date.now()) {
  const path = heartbeatPath(config, worktree);
  atomicJson(path, {
    instanceId,
    pid: process.pid,
    worktreePath: resolve(worktree),
    at: nowMs,
    expiresAt: nowMs + config.heartbeatTtlMs,
  });
  return path;
}

function readHeartbeats(config, worktree, nowMs) {
  const dir = join(config.stateDir, 'heartbeats');
  if (!existsSync(dir)) return [];
  const prefix = `${leaseKey(worktree)}-`;
  return readdirSync(dir)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
    .flatMap((name) => {
      try {
        const value = JSON.parse(readFileSync(join(dir, name), 'utf8'));
        return value.worktreePath === resolve(worktree) && value.expiresAt > nowMs
          ? [{ kind: 'heartbeat', at: value.at, live: true, detail: value.instanceId }]
          : [];
      } catch {
        return [];
      }
    });
}

function worktreePaths(rootDir) {
  const result = new Set();
  const candidates = [rootDir];
  if (existsSync(rootDir)) {
    for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) candidates.push(join(rootDir, entry.name));
    }
  }
  for (const candidate of candidates) {
    if (!existsSync(join(candidate, '.git'))) continue;
    result.add(resolve(candidate));
    const listed = runGit(candidate, ['worktree', 'list', '--porcelain']);
    if (!listed.ok) continue;
    for (const line of listed.stdout.split('\n')) {
      if (line.startsWith('worktree ')) result.add(resolve(line.slice('worktree '.length)));
    }
  }
  return [...result].filter((path) => existsSync(join(path, '.git'))).sort();
}

function fileSignals(worktree, changedPaths) {
  const signals = [];
  const gitPath = join(worktree, '.git');
  try {
    const gitStat = statSync(gitPath);
    signals.push({ kind: 'git-metadata', at: gitStat.mtimeMs, live: true });
  } catch {
    // The caller will report the worktree as unreadable.
  }
  for (const relative of changedPaths) {
    try {
      const fileStat = statSync(join(worktree, relative));
      signals.push({ kind: 'file-write', at: fileStat.mtimeMs, live: true, detail: relative });
    } catch {
      // A deleted path has no file timestamp. Git status still records it.
    }
  }
  return signals;
}

function processSignals(worktree, nowMs) {
  const probe = spawnSync('/usr/sbin/lsof', ['-a', '-d', 'cwd', '-Fpcn'], { encoding: 'utf8' });
  if (probe.status !== 0) return { known: false, active: false, signals: [] };
  let pid = null;
  let command = null;
  const activeNames = /^(?:claude|codex|agy|grok|node|npm|pnpm|bun|git|zsh|bash|fish|sh|python|ruby|playwright|vite|wrangler)$/i;
  const signals = [];
  const records = probe.stdout.split('\n');
  for (const record of records) {
    if (record.startsWith('p')) pid = Number(record.slice(1));
    else if (record.startsWith('c')) command = record.slice(1);
    else if (record.startsWith('n') && resolve(record.slice(1)) === resolve(worktree)) {
      if (pid !== process.pid && activeNames.test(command || '')) {
        signals.push({ kind: 'process', at: nowMs, live: true, detail: `${command}:${pid}` });
      }
    }
  }
  return { known: true, active: signals.length > 0, signals };
}

function inspectWorktree(config, worktree, instanceId, nowMs) {
  const branch = currentBranch(worktree);
  const changed = listChangedPaths(worktree);
  const lease = readLease(config.stateDir, worktree);
  const leaseSignal = lease
    ? [{ kind: 'lease', at: lease.heartbeatAt, live: lease.expiresAt > nowMs, detail: lease.ownerId }]
    : [];
  const processProbe = processSignals(worktree, nowMs);
  const signals = [
    ...readHeartbeats(config, worktree, nowMs),
    ...leaseSignal,
    ...processProbe.signals,
    ...fileSignals(worktree, changed),
  ];
  const activity = classifyActivity({ nowMs, signals });
  const isDefault = branch === defaultBranch(worktree);
  const owner = lease?.ownerId === instanceId && lease.expiresAt > nowMs;
  const remote = runGit(worktree, ['remote', 'get-url', 'origin']);
  const repository = remote.ok ? repositoryFromRemote(remote.stdout.trim()) : null;
  return {
    worktree,
    branch,
    defaultBranch: isDefault,
    dirty: changed.length > 0,
    changedPaths: changed,
    owner,
    repository,
    ownerId: lease?.ownerId || null,
    processActive: processProbe.active,
    processCheckKnown: processProbe.known,
    ciActive: false,
    deployActive: false,
    conflict: changed.some((path) => path.includes('CONFLICT')),
    protectedBranch: isDefault,
    signals,
    activity,
  };
}

function repositoryFromRemote(remote) {
  const match = remote.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/i);
  return match ? `${match[1]}/${match[2]}` : null;
}

function verifyGitInvariants(repo) {
  const check = runGit(repo.worktree, ['diff', '--check']);
  if (!check.ok) return { ok: false, reason: `git diff --check failed: ${check.stderr.trim() || check.stdout.trim()}` };
  return { ok: true, reason: 'git diff --check passed' };
}

function verifyRepository(repoDir, timeoutMs = 300000) {
  const packagePath = join(repoDir, 'package.json');
  if (!existsSync(packagePath)) return { ok: true, reason: 'no package manifest, Git invariants only' };
  let scripts;
  try {
    scripts = JSON.parse(readFileSync(packagePath, 'utf8')).scripts || {};
  } catch (error) {
    return { ok: false, reason: `package.json is malformed: ${error.message}` };
  }
  const check = ['test', 'typecheck', 'lint', 'check'].find((name) => scripts[name]);
  if (!check) return { ok: true, reason: 'no configured verification script' };
  const result = spawnSync('npm', ['run', '--silent', check], {
    cwd: repoDir,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
  });
  return {
    ok: result.status === 0,
    command: `npm run --silent ${check}`,
    reason: result.status === 0 ? 'repository verification passed' : `repository verification failed: ${(result.stderr || result.stdout || '').slice(-1200)}`,
  };
}

function printResult(result) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig(args.configPath);
  const nowMs = Date.now();

  if (args.heartbeat) {
    if (!args.worktree) throw new Error('--heartbeat requires --worktree');
    const path = recordHeartbeat(config, args.worktree, args.instanceId, nowMs);
    printResult({ status: 'green', action: 'heartbeat', worktree: resolve(args.worktree), path });
    return;
  }

  const roots = args.worktree ? [resolve(args.worktree)] : worktreePaths(config.rootDir);
  const results = [];
  for (const worktree of roots) {
    let inspection;
    try {
      inspection = inspectWorktree(config, worktree, args.instanceId, nowMs);
    } catch (error) {
      const result = { status: 'failed', action: 'inspect', worktree, reason: error.message };
      results.push(result);
      writeReceipt(config.receiptPath, result);
      continue;
    }
    const repositoryOwner = inspection.repository?.split('/')[0] || null;
    const planned = planWorktree({
      nowMs,
      signals: inspection.signals,
      dirty: inspection.dirty,
      branch: inspection.branch,
      defaultBranch: inspection.defaultBranch,
      owner: inspection.owner,
      ownerMode: config.ownerMode,
      configuredOwner: config.repositoryOwner,
      repositoryOwner,
      processActive: inspection.processActive,
      processCheckKnown: inspection.processCheckKnown,
      ciActive: inspection.ciActive,
      deployActive: inspection.deployActive,
      conflict: inspection.conflict,
      protectedBranch: false,
    });
    const result = {
      status: args.dryRun ? 'not run' : 'partial',
      worktree,
      branch: inspection.branch,
      dirty: inspection.dirty,
      changedPathCount: inspection.changedPaths.length,
      activity: inspection.activity.state,
      idleMs: inspection.activity.idleMs,
      action: planned.action,
      reason: planned.reason,
    };

    if (!args.dryRun && planned.action === 'reconcile-clean') {
      const acquired = acquireLease({
        stateDir: config.stateDir,
        worktreePath: worktree,
        ownerId: args.instanceId,
        repository: worktree,
        branch: inspection.branch,
        nowMs,
        ttlMs: config.leaseTtlMs,
      });
      if (!acquired.acquired) {
        result.status = 'blocked';
        result.action = 'record-held';
        result.reason = acquired.reason;
      } else {
        try {
          const reconciliation = reconcileCleanBranch({
            repoDir: worktree,
            branch: inspection.branch,
            defaultBranchName: defaultBranch(worktree),
          });
          result.reconciliation = reconciliation;
          result.status = reconciliation.held ? 'blocked' : reconciliation.reconciled ? 'green' : 'partial';
          result.action = reconciliation.reconciled ? 'reconciled-clean' : 'record-held';
          result.reason = reconciliation.reason;
        } catch (error) {
          result.status = 'failed';
          result.action = 'record-held';
          result.reason = error.message;
        }
      }
    }

    if (!args.dryRun && (planned.action === 'checkpoint-owned' || planned.action === 'adopt-and-checkpoint')) {
      const acquired = acquireLease({
        stateDir: config.stateDir,
        worktreePath: worktree,
        ownerId: args.instanceId,
        repository: worktree,
        branch: inspection.branch,
        nowMs,
        ttlMs: config.leaseTtlMs,
      });
      if (!acquired.acquired) {
        result.status = 'blocked';
        result.action = 'record-held';
        result.reason = acquired.reason;
      } else {
        let branch = inspection.branch;
        try {
          if (inspection.defaultBranch) {
            const slug = worktree.split('/').filter(Boolean).pop().replace(/[^A-Za-z0-9._-]+/g, '-');
            branch = `agent/autocheckpoint/${slug}-${nowMs}`;
            createFeatureBranch({ repoDir: worktree, branch });
          }
          const checkpoint = checkpointWorktree({
            repoDir: worktree,
            message: `chore: checkpoint ${branch}`,
          });
          result.branch = branch;
          result.checkpoint = checkpoint;
          if (!checkpoint.committed) {
            result.status = checkpoint.held ? 'blocked' : 'partial';
            result.action = 'record-held';
          } else {
            const verification = verifyGitInvariants({ ...inspection, worktree });
            result.verification = verification;
            const repositoryVerification = verification.ok
              ? verifyRepository(worktree)
              : { ok: false, reason: 'repository verification skipped because Git check failed' };
            result.repositoryVerification = repositoryVerification;
            if (!verification.ok || !repositoryVerification.ok) {
              result.status = 'blocked';
              result.action = 'record-held';
            } else if (!inspection.repository) {
              result.status = 'partial';
              result.action = 'checkpoint-local';
              result.reason = 'checkpoint verified but no GitHub origin was resolved';
            } else {
              const pushed = pushFeatureBranch({ repoDir: worktree, branch });
              result.push = pushed;
              result.status = 'green';
              result.action = 'published-feature-branch';
              if (config.autoDraftPullRequest) {
                result.pullRequest = createDraftPullRequest({
                  repoDir: worktree,
                  repo: inspection.repository,
                  base: defaultBranch(worktree),
                  head: branch,
                });
              }
              const manifest = loadDeployManifest(worktree);
              if (manifest) {
                try {
                  result.deployment = runDeployment({
                    repoDir: worktree,
                    branch,
                    manifest,
                    timeoutMs: config.deployTimeoutMs || 900000,
                  });
                  if (result.deployment.status !== 'green') {
                    result.status = 'partial';
                    result.action = 'published-not-deployed';
                    result.reason = result.deployment.reason;
                  }
                } catch (error) {
                  result.status = 'failed';
                  result.action = 'published-deploy-failed';
                  result.reason = error.message;
                }
              }
            }
          }
        } catch (error) {
          result.status = 'failed';
          result.action = 'record-held';
          result.reason = error.message;
        }
      }
    }
    results.push(result);
    writeReceipt(config.receiptPath, result);
  }

  if (args.status || args.once) printResult({ status: 'green', count: results.length, results });
}

function createDraftPullRequest({ repoDir, repo, base, head }) {
  const existing = spawnSync('gh', ['pr', 'list', '--repo', repo, '--head', head, '--state', 'open', '--json', 'number', '--limit', '1'], {
    cwd: repoDir,
    encoding: 'utf8',
  });
  if (existing.status !== 0) throw new Error(`cannot inspect pull requests: ${(existing.stderr || existing.stdout).trim()}`);
  let rows;
  try {
    rows = JSON.parse(existing.stdout || '[]');
  } catch {
    throw new Error('GitHub pull request listing returned malformed JSON');
  }
  if (rows.length > 0) return { action: 'existing', number: rows[0].number };
  const created = spawnSync('gh', draftPullRequestArgs({ repo, base, head }), { cwd: repoDir, encoding: 'utf8' });
  if (created.status !== 0) throw new Error(`draft pull request failed: ${(created.stderr || created.stdout).trim()}`);
  return { action: 'created', output: created.stdout.trim() };
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
}
