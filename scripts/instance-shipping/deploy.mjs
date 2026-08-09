import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { manifestAllowsBranch } from './manifest.mjs';

export function loadDeployManifest(repoDir) {
  const path = join(repoDir, '.stack-ops', 'deploy.json');
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function defaultRunner(command, cwd, timeoutMs) {
  const result = spawnSync('/bin/sh', ['-lc', command], {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
  });
  return {
    ok: result.status === 0,
    timedOut: result.status === null,
    output: (result.stderr || result.stdout || '').slice(-1200),
  };
}

export function runDeployment({ repoDir, branch, manifest, timeoutMs = 900000, runner = defaultRunner } = {}) {
  const policy = manifestAllowsBranch(manifest, branch);
  if (!policy.allowed) return { status: 'held', reason: policy.reason, steps: [] };
  const steps = [];
  for (const phase of ['verify', 'deploy', 'liveCheck']) {
    for (const command of manifest[phase]) {
      const result = runner(command, repoDir, timeoutMs);
      const step = {
        phase,
        command,
        status: result.ok ? 'passed' : result.timedOut ? 'timed_out' : 'failed',
      };
      steps.push(step);
      if (!result.ok) {
        return {
          status: phase === 'liveCheck' ? 'live-check-failed' : 'failed',
          reason: `${phase} command did not pass`,
          steps,
        };
      }
    }
  }
  return { status: 'green', reason: 'verification, deployment, and live check passed', steps };
}
