#!/usr/bin/env node
// nightly-hygiene.mjs: unattended overnight repo hygiene across ~/Documents.
//
// Per repo: safe branch prune -> headless Claude review+fix pass -> verify ->
// secret/personal-data screen -> commit -> push to the repo's CURRENT branch.
//
// Design decisions worth knowing before editing this file:
//
//  * It pushes to the repo's CURRENT branch, not literally to `main`. Ten of the
//    fifteen repos sit on main/master, so for those it IS a push to main. Four sit
//    on active feature branches; pushing their work to main would destroy it.
//  * It commits ONLY files the Claude pass itself changed. Pre-existing dirty
//    files are Mitchell's in-progress work and are reported, never committed.
//    Flip `commitPreexistingDirty` in config.json to change that.
//  * Billing goes through /Users/mitchellwilliams/.claude/bin/claude, the wrapper
//    that strips ANTHROPIC_API_KEY so the run draws the subscription, not the
//    metered API. Never swap this for a bare `claude`.
//  * Any failure after the Claude pass reverts that repo's job-made changes and
//    moves on. One bad repo never blocks the other fourteen.
//
// Usage:
//   node nightly-hygiene.mjs                 # full run, honours config.json
//   node nightly-hygiene.mjs --dry-run       # everything except commit/push
//   node nightly-hygiene.mjs --repos a,b     # subset
//   node nightly-hygiene.mjs --no-push       # commit locally, skip push

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { screen } from './guards.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG = JSON.parse(readFileSync(join(HERE, 'config.json'), 'utf8'));
const PROMPT_TEMPLATE = readFileSync(join(HERE, 'prompt.md'), 'utf8');

const ARGS = process.argv.slice(2);
const DRY_RUN = ARGS.includes('--dry-run');
const NO_PUSH = ARGS.includes('--no-push') || DRY_RUN;
const ONLY = (ARGS.find((a) => a.startsWith('--repos=')) || '').split('=')[1];

const STARTED_AT = new Date();
const RUN_ID = STARTED_AT.toISOString().replace(/[:.]/g, '-');
const RUN_LOG_DIR = join(CONFIG.logDir, RUN_ID);
mkdirSync(RUN_LOG_DIR, { recursive: true });

// Circuit breaker. The 2026-08-06 pilot measured $2.24 for one small repo, and
// the wrapper is not proven to keep this off the metered API. An unattended job
// that can quietly bill four figures a month gets a hard ceiling, not a hope.
const SPEND = { total: 0 };

// ---------------------------------------------------------------- utilities

function log(...parts) {
  const stamp = new Date().toISOString();
  const line = `[${stamp}] ${parts.join(' ')}`;
  console.log(line);
  try {
    writeFileSync(join(CONFIG.logDir, 'nightly-hygiene.log'), line + '\n', { flag: 'a' });
  } catch { /* logging must never throw */ }
}

/** Run a command, returning {code, stdout, stderr}. Never throws. */
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: opts.timeoutMs,
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env || {}) },
    input: opts.input,
  });
  return {
    code: r.status === null ? 124 : r.status, // 124 = timed out
    stdout: r.stdout || '',
    stderr: r.stderr || (r.error ? String(r.error.message) : ''),
    timedOut: r.status === null,
  };
}

const git = (repoDir, args, opts = {}) => run('git', args, { cwd: repoDir, ...opts });

/**
 * Text that means the machine is broken, not that this repo is broken. A TCC
 * revocation, a denied getcwd, or a vanished working directory are all faults
 * that will hit every remaining repo identically, so they must never be recorded
 * as a per-repo verdict. See the 2026-08-07 run: one fault at 02:08:13 was
 * reported as 12 separate repo failures.
 */
function isEnvironmentFault(text) {
  return /Operation not permitted|EPERM|getcwd|shell-init|no such file or directory \(os error 2\)/i.test(String(text || ''));
}

/**
 * True when this process can still read the tree it is supposed to be working
 * on. Probes the same three access paths that died together on 2026-08-07:
 * a direct read, a listing, and a shell started with its cwd inside the tree.
 */
function documentsReadable() {
  try { readdirSync(CONFIG.rootDir); } catch { return false; }
  const sh = run('/bin/sh', ['-c', 'pwd >/dev/null && echo ok'], { cwd: CONFIG.rootDir, timeoutMs: 15_000 });
  return sh.code === 0 && !isEnvironmentFault(sh.stderr);
}

/**
 * Parse `git status --porcelain=v1 -z` into Map(path -> XY status).
 *
 * Throws on git failure. It used to swallow it and return an empty Map, which
 * made a blind run indistinguishable from a clean one: diffStatus would find no
 * changes and the repo would be reported "clean-no-changes" while the job could
 * not actually see the files. A check that cannot fail is not a check.
 */
function statusMap(repoDir) {
  const r = git(repoDir, ['status', '--porcelain=v1', '-z']);
  if (r.code !== 0) {
    throw new Error(`git status failed in ${repoDir}: ${(r.stderr || '').trim().slice(0, 200) || 'exit ' + r.code}`);
  }
  const { stdout } = r;
  const map = new Map();
  const parts = stdout.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry) continue;
    const xy = entry.slice(0, 2);
    let path = entry.slice(3);
    // Renames/copies carry a second NUL-separated path (the origin).
    if (xy[0] === 'R' || xy[0] === 'C') i++;
    map.set(path, xy);
  }
  return map;
}

/** Files whose status appeared or changed between two snapshots. */
function diffStatus(before, after) {
  const changed = [];
  for (const [path, xy] of after) {
    if (before.get(path) !== xy) changed.push(path);
  }
  return changed;
}

function isTracked(repoDir, relPath) {
  return git(repoDir, ['ls-files', '--error-unmatch', '--', relPath]).code === 0;
}

/** Undo the job's own edits without touching anything it did not create. */
function revertPaths(repoDir, relPaths) {
  for (const p of relPaths) {
    if (isTracked(repoDir, p)) {
      git(repoDir, ['checkout', '--', p]);
    } else {
      try { rmSync(join(repoDir, p), { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
}

// ------------------------------------------------------- phase A: git-cleanup
//
// The /git-cleanup skill is disable-model-invocation:true and states it is not
// designed for headless automation (it gates on two user confirmations). This is
// the deterministic subset that is safe without a human: prune remote-tracking
// refs, and delete local branches that are BOTH fully merged into the default
// branch AND whose upstream is gone. Never the current branch, never the default
// branch, never an unmerged branch.

function safeBranchCleanup(repoDir, currentBranch, defaultBranch) {
  const removed = [];
  const kept = [];
  if (!defaultBranch) return { removed, kept, note: 'default branch unknown, skipped' };

  git(repoDir, ['fetch', '--prune', '--quiet'], { timeoutMs: 120_000 });

  const merged = git(repoDir, ['branch', '--merged', `origin/${defaultBranch}`, '--format=%(refname:short)'])
    .stdout.split('\n').map((s) => s.trim()).filter(Boolean);

  const goneRaw = git(repoDir, ['for-each-ref', '--format=%(refname:short) %(upstream:track)', 'refs/heads'])
    .stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  const gone = new Set(
    goneRaw.filter((l) => l.includes('[gone]')).map((l) => l.split(' ')[0]),
  );

  for (const branch of merged) {
    if (branch === currentBranch || branch === defaultBranch) continue;
    if (!gone.has(branch)) { kept.push({ branch, why: 'merged but upstream still present' }); continue; }
    const r = git(repoDir, ['branch', '-d', branch]);
    if (r.code === 0) removed.push(branch);
    else kept.push({ branch, why: `git refused: ${r.stderr.trim().slice(0, 120)}` });
  }

  // Report squash-merged candidates; deleting these needs -D and a human eye.
  for (const line of goneRaw) {
    const [branch] = line.split(' ');
    if (!gone.has(branch)) continue;
    if (branch === currentBranch || branch === defaultBranch) continue;
    if (merged.includes(branch)) continue;
    kept.push({ branch, why: 'upstream gone but not fully merged, likely squash-merged, needs your -D' });
  }

  return { removed, kept };
}

// ---------------------------------------------------- phase B: the Claude pass

function buildPrompt(repo, preexisting) {
  const list = preexisting.length
    ? preexisting.slice(0, 200).map((p) => `  - ${p}`).join('\n') +
      (preexisting.length > 200 ? `\n  …and ${preexisting.length - 200} more` : '')
    : '  (none)';
  return PROMPT_TEMPLATE
    .replaceAll('{{REPO_NAME}}', repo.name)
    .replaceAll('{{REPO_DIR}}', repo.dir)
    .replaceAll('{{BRANCH}}', repo.branch)
    .replaceAll('{{LOG_DIR}}', RUN_LOG_DIR)
    .replaceAll('{{PREEXISTING_DIRTY}}', list);
}

function runClaudePass(repo, prompt) {
  const args = [
    '-p', prompt,
    '--output-format', 'json',
    '--permission-mode', 'acceptEdits',
    '--model', CONFIG.model,
    '--effort', CONFIG.effort || 'medium',
    '--add-dir', repo.dir,
  ];
  if (CONFIG.fallbackModel) args.push('--fallback-model', CONFIG.fallbackModel);

  // cwd is deliberately NOT repo.dir. CONFIG.claudeBin is a /bin/sh wrapper, and
  // a shell started with its cwd inside ~/Documents calls getcwd() at init; when
  // the TCC grant is not in force that fails with "shell-init: ... getcwd ...
  // Operation not permitted" before claude ever runs. The repo reaches claude via
  // --add-dir instead, so no process in the chain needs a cwd under ~/Documents.
  const spawnOpts = {
    cwd: RUN_LOG_DIR,
    timeoutMs: CONFIG.perRepoTimeoutMs,
    // Belt and braces: the wrapper already strips this, but if anything ever
    // resolves the raw binary instead, an absent key still cannot bill per token.
    env: { ANTHROPIC_API_KEY: '' },
  };

  let r = run(CONFIG.claudeBin, args, spawnOpts);

  // One retry, only for machine-level faults and only when the tree is readable
  // again. A repo-level failure is never retried: it would just cost twice.
  if (r.code !== 0 && isEnvironmentFault(r.stderr) && documentsReadable()) {
    log('  environment fault on first attempt, tree is readable again, retrying once');
    r = run(CONFIG.claudeBin, args, spawnOpts);
  }

  writeFileSync(join(RUN_LOG_DIR, `${repo.name}.claude.json`), r.stdout || r.stderr || '');

  if (r.timedOut) return { ok: false, error: `timed out after ${CONFIG.perRepoTimeoutMs}ms` };
  if (r.code !== 0) {
    return {
      ok: false,
      error: `claude exited ${r.code}: ${r.stderr.slice(0, 400)}`,
      envFault: isEnvironmentFault(r.stderr),
    };
  }

  let report = null;
  let costUsd = 0;
  try {
    const envelope = JSON.parse(r.stdout);
    costUsd = Number(envelope.total_cost_usd) || 0;
    const text = typeof envelope.result === 'string' ? envelope.result : r.stdout;
    const m = text.match(/\{[\s\S]*\}/);
    if (m) report = JSON.parse(m[0]);
  } catch { /* report stays null; the git diff is the source of truth anyway */ }

  return { ok: true, report, costUsd };
}

// ------------------------------------------------------------ phase C: verify

function verifyRepo(repoDir, changedFiles) {
  const results = [];

  for (const f of changedFiles.filter((p) => /\.(mjs|cjs|js)$/.test(p))) {
    if (!existsSync(join(repoDir, f))) continue;
    const r = run('node', ['--check', f], { cwd: repoDir, timeoutMs: 30_000 });
    results.push({ command: `node --check ${f}`, passed: r.code === 0, detail: r.stderr.slice(0, 400) });
    if (r.code !== 0) return { passed: false, results };
  }

  const pkgPath = join(repoDir, 'package.json');
  if (existsSync(pkgPath)) {
    let scripts = {};
    try { scripts = JSON.parse(readFileSync(pkgPath, 'utf8')).scripts || {}; } catch { /* ignore */ }
    for (const name of CONFIG.verifyScripts) {
      if (!scripts[name]) continue;
      const r = run('npm', ['run', '--silent', name], { cwd: repoDir, timeoutMs: CONFIG.verifyTimeoutMs });
      const passed = r.code === 0;
      results.push({ command: `npm run ${name}`, passed, detail: (r.stderr || r.stdout).slice(-1500) });
      if (!passed) return { passed: false, results };
      break; // first available check is enough
    }
  }

  return { passed: true, results };
}

// ------------------------------------------------------------ the per-repo run

function processRepo(repo) {
  const out = {
    repo: repo.name, dir: repo.dir, branch: repo.branch,
    cleanup: null, claude: null, verify: null, guard: null,
    committed: false, pushed: false, sha: null,
    preexistingDirty: 0, status: 'pending', error: null, deferred: [],
  };

  log(`--- ${repo.name} (${repo.branch}) ---`);

  const baseSha = git(repo.dir, ['rev-parse', 'HEAD']).stdout.trim();
  const before = statusMap(repo.dir);
  out.preexistingDirty = before.size;

  // A. deterministic branch cleanup (safe subset of /git-cleanup)
  out.cleanup = safeBranchCleanup(repo.dir, repo.branch, repo.defaultBranch);
  if (out.cleanup.removed.length) log(`  pruned branches: ${out.cleanup.removed.join(', ')}`);

  // B. Claude review + fix pass
  const pass = runClaudePass(repo, buildPrompt(repo, [...before.keys()]));
  out.claude = pass;
  out.costUsd = pass.costUsd || 0;
  SPEND.total += out.costUsd;
  if (out.costUsd) log(`  cost $${out.costUsd.toFixed(2)} (run total $${SPEND.total.toFixed(2)})`);
  if (!pass.ok) {
    out.status = pass.envFault ? 'environment-fault' : 'claude-failed';
    out.error = pass.error;
    out.envFault = !!pass.envFault;
    log(`  FAILED${pass.envFault ? ' (environment, not this repo)' : ''}: ${pass.error}`);
    return out;
  }
  out.deferred = pass.report?.deferred || [];

  const after = statusMap(repo.dir);
  const jobChanged = diffStatus(before, after);
  out.jobChanged = jobChanged;

  if (!jobChanged.length) {
    out.status = 'clean-no-changes';
    log('  no changes made');
    return out;
  }
  log(`  changed ${jobChanged.length} file(s)`);

  // C. verify
  out.verify = verifyRepo(repo.dir, jobChanged);
  if (!out.verify.passed) {
    revertPaths(repo.dir, jobChanged);
    out.status = 'verify-failed-reverted';
    out.error = out.verify.results.at(-1)?.command;
    log(`  verification failed, reverted: ${out.error}`);
    return out;
  }

  // D. secret + personal-data screen
  const { allowed, blocked } = screen(repo.dir, jobChanged);
  out.guard = { allowedCount: allowed.length, blocked };
  if (blocked.length) {
    revertPaths(repo.dir, jobChanged);
    out.status = 'guard-blocked-reverted';
    out.error = blocked.map((b) => `${b.path}: ${b.reason}`).join('; ');
    log(`  GUARD BLOCKED, whole repo reverted: ${out.error}`);
    return out;
  }

  if (DRY_RUN) {
    revertPaths(repo.dir, jobChanged);
    out.status = 'dry-run-reverted';
    log('  dry run, reverted');
    return out;
  }

  // E. commit, explicit pathspec only, never `git add -A`
  const addArgs = ['add', '--'].concat(allowed);
  const added = git(repo.dir, addArgs);
  if (added.code !== 0) {
    revertPaths(repo.dir, jobChanged);
    out.status = 'add-failed-reverted';
    out.error = added.stderr.slice(0, 300);
    return out;
  }

  const summary = (pass.report?.fixes || []).slice(0, 8)
    .map((f) => `- ${f.file}: ${f.what}`).join('\n');
  const message = [
    `chore: nightly hygiene pass ${STARTED_AT.toISOString().slice(0, 10)}`,
    '',
    summary || `Automated review and fix pass over ${allowed.length} file(s).`,
    '',
    `Runner: scripts/nightly-hygiene/nightly-hygiene.mjs (run ${RUN_ID})`,
    `Base: ${baseSha}`,
  ].join('\n');

  const committed = git(repo.dir, ['commit', '-m', message]);
  if (committed.code !== 0) {
    git(repo.dir, ['reset', 'HEAD', '--'].concat(allowed));
    revertPaths(repo.dir, jobChanged);
    out.status = 'commit-failed-reverted';
    out.error = committed.stderr.slice(0, 300);
    return out;
  }
  out.committed = true;
  out.sha = git(repo.dir, ['rev-parse', 'HEAD']).stdout.trim();
  log(`  committed ${out.sha.slice(0, 8)}`);

  // F. push to the repo's current branch
  if (NO_PUSH) { out.status = 'committed-not-pushed'; return out; }
  if (!repo.hasOrigin) { out.status = 'committed-no-remote'; log('  no origin remote, not pushed'); return out; }

  const pushed = git(repo.dir, ['push', 'origin', `HEAD:${repo.branch}`], { timeoutMs: 180_000 });
  if (pushed.code !== 0) {
    out.status = 'push-failed-commit-kept';
    out.error = pushed.stderr.slice(0, 400);
    log(`  push failed (commit kept locally): ${out.error}`);
    return out;
  }
  out.pushed = true;
  out.status = 'pushed';
  log(`  pushed to origin/${repo.branch}`);
  return out;
}

// -------------------------------------------------------------- repo discovery

function discoverRepos() {
  // `; true` matters: with no matching dirs the final [ -d ] test fails and the
  // shell exits 1, which would make execFileSync throw and kill the whole run.
  const names = execFileSync('/bin/sh', ['-c',
    `cd ${JSON.stringify(CONFIG.rootDir)} && for d in */; do [ -d "$d/.git" ] && echo "\${d%/}"; done; true`,
  ], { encoding: 'utf8' }).split('\n').filter(Boolean);

  const wanted = ONLY ? new Set(ONLY.split(',')) : null;

  return names
    .filter((n) => !CONFIG.skipRepos.includes(n))
    .filter((n) => !wanted || wanted.has(n))
    .map((name) => {
      const dir = join(CONFIG.rootDir, name);
      const branch = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
      const hasOrigin = git(dir, ['remote', 'get-url', 'origin']).code === 0;
      let defaultBranch = git(dir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
        .stdout.trim().replace(/^origin\//, '');
      if (!defaultBranch && hasOrigin) {
        // origin/HEAD is not set locally; ask the remote once.
        const r = git(dir, ['remote', 'show', 'origin'], { timeoutMs: 30_000 });
        defaultBranch = (r.stdout.match(/HEAD branch:\s*(\S+)/) || [])[1] || '';
      }
      return { name, dir, branch, hasOrigin, defaultBranch: defaultBranch || null };
    })
    .filter((r) => {
      if (!r.branch || r.branch === 'HEAD') {
        log(`skip ${r.name}: detached HEAD`);
        return false;
      }
      return true;
    });
}

// ------------------------------------------------------------------ the report

function writeReport(results, abortedReason = null) {
  const finished = new Date();
  const mins = Math.round((finished - STARTED_AT) / 60000);
  const by = (s) => results.filter((r) => r.status === s);

  const lines = [];
  lines.push(`# Nightly hygiene, ${STARTED_AT.toISOString().slice(0, 10)}`);
  lines.push('');
  lines.push(`Ran ${results.length} repos in ${mins} min. Run id \`${RUN_ID}\`.`);
  lines.push('');

  // A degraded run leads with what did not run and why, never with its successes.
  if (abortedReason) {
    lines.push('> **This run stopped early on a machine-level fault.**');
    lines.push('>');
    lines.push(`> ${abortedReason}`);
    lines.push('');
  }
  lines.push(`**Pushed:** ${by('pushed').length} · **Clean, nothing to do:** ${by('clean-no-changes').length} · **Held back:** ${results.length - by('pushed').length - by('clean-no-changes').length}`);
  lines.push('');
  lines.push(`**Cost this run: $${SPEND.total.toFixed(2)}** (cap $${CONFIG.nightlyCostCapUsd ?? 'none'}). Check this against your Anthropic console for the first week: the wrapper is meant to bill the subscription, but the 2026-08-06 incident showed that is not guaranteed.`);
  if (by('skipped-cost-cap').length) {
    lines.push('');
    lines.push(`> Cost cap stopped the run. ${by('skipped-cost-cap').length} repo(s) were skipped and will be first in line tomorrow (order rotates daily).`);
  }
  lines.push('');
  lines.push('| Repo | Branch | Outcome | Files | Commit |');
  lines.push('|---|---|---|---|---|');
  for (const r of results) {
    lines.push(`| ${r.repo} | ${r.branch} | ${r.status} | ${r.jobChanged?.length ?? 0} | ${r.sha ? r.sha.slice(0, 8) : ', '} |`);
  }
  lines.push('');

  const problems = results.filter((r) => r.error);
  if (problems.length) {
    lines.push('## Needs your eye');
    lines.push('');
    for (const r of problems) lines.push(`- **${r.repo}** (${r.status}): ${r.error}`);
    lines.push('');
  }

  const prunable = results.flatMap((r) => (r.cleanup?.kept || [])
    .filter((k) => k.why.includes('squash-merged'))
    .map((k) => `- \`${r.repo}\`: \`git -C ${r.dir} branch -D ${k.branch}\``));
  if (prunable.length) {
    lines.push('## Branches I would not delete unattended (squash-merged, need `-D`)');
    lines.push('');
    lines.push(...prunable);
    lines.push('');
  }

  const dirty = results.filter((r) => r.preexistingDirty > 0)
    .sort((a, b) => b.preexistingDirty - a.preexistingDirty);
  if (dirty.length) {
    lines.push('## Uncommitted work I did not touch');
    lines.push('');
    lines.push('Your in-progress files. The job never commits these by design.');
    lines.push('');
    for (const r of dirty) lines.push(`- \`${r.repo}\`: ${r.preexistingDirty} file(s)`);
    lines.push('');
  }

  const deferred = results.flatMap((r) => r.deferred.map((d) => `- **${r.repo}**: ${d.what} (${d.why_deferred})`));
  if (deferred.length) {
    lines.push('## Deferred to you');
    lines.push('');
    lines.push(...deferred);
    lines.push('');
  }

  const md = lines.join('\n');
  const mdPath = join(CONFIG.logDir, 'latest-report.md');
  writeFileSync(mdPath, md);
  writeFileSync(join(RUN_LOG_DIR, 'report.md'), md);
  writeFileSync(join(RUN_LOG_DIR, 'report.json'), JSON.stringify({ runId: RUN_ID, startedAt: STARTED_AT, results }, null, 2));
  log(`report: ${mdPath}`);
  return mdPath;
}

// ------------------------------------------------------- billing preflight
//
// Standing rule: subscription first, and API spend only after an explicit
// ruling. This gate is FAIL CLOSED. If the subscription path is not provably
// available, the run spends nothing rather than silently falling back to the
// metered API. That fallback is exactly what produced the $1,377 surprise
// across 2026-08-01..06.
//
// It cannot read the billing path out of the API response (no field exposes
// it), so it verifies the three preconditions it can check, none of which
// require reading a secret value.

function preflightBilling() {
  const problems = [];

  if (!existsSync(CONFIG.claudeBin)) {
    problems.push(`claudeBin missing: ${CONFIG.claudeBin}`);
  } else {
    // The wrapper must actually strip the key. A bare `claude` here would bill
    // per token, because ANTHROPIC_API_KEY outranks subscription OAuth.
    let body = '';
    try { body = readFileSync(CONFIG.claudeBin, 'utf8'); } catch { /* handled below */ }
    if (!body.includes('env -u ANTHROPIC_API_KEY')) {
      problems.push(`${CONFIG.claudeBin} does not strip ANTHROPIC_API_KEY; it would bill the metered API`);
    }
  }

  // Existence check only. `-w` would print the secret, so it is never used.
  const keychain = run('/usr/bin/security',
    ['find-generic-password', '-s', 'Claude Code-credentials']);
  if (keychain.code !== 0) {
    problems.push('no subscription credential in the keychain (run `claude` once to log in)');
  }

  return problems;
}

// ------------------------------------------------------------------------ main

function main() {
  log(`=== nightly hygiene start (run ${RUN_ID})${DRY_RUN ? ' [DRY RUN]' : ''} ===`);

  const billingProblems = preflightBilling();
  if (billingProblems.length) {
    for (const p of billingProblems) log(`BILLING PREFLIGHT FAILED: ${p}`);
    log('refusing to run. Subscription first: no API spend without an explicit ruling.');
    writeFileSync(join(CONFIG.logDir, 'latest-report.md'), [
      `# Nightly hygiene, ${STARTED_AT.toISOString().slice(0, 10)}`,
      '',
      '**The run did not start.** The subscription path could not be verified, and this job',
      'never falls back to metered API spend on its own.',
      '',
      ...billingProblems.map((p) => `- ${p}`),
      '',
      'Fix the above, or rule explicitly that API spend is acceptable for this job.',
    ].join('\n'));
    return;
  }
  log('billing preflight ok: subscription wrapper present, keychain credential present');

  const lockPath = join(CONFIG.logDir, 'run.lock');
  if (existsSync(lockPath)) {
    const age = Date.now() - Number(readFileSync(lockPath, 'utf8').trim() || 0);
    if (age < CONFIG.globalDeadlineMs) { log('another run holds the lock, exiting'); return; }
    log('stale lock, taking over');
  }
  writeFileSync(lockPath, String(Date.now()));

  const results = [];
  let abortedReason = null;
  try {
    let repos = discoverRepos();

    // Rotate the starting point by day-of-year. With a cost cap, a fixed order
    // would starve whatever sits at the end of the list every single night.
    if (repos.length > 1) {
      const dayOfYear = Math.floor((STARTED_AT - new Date(STARTED_AT.getFullYear(), 0, 0)) / 86400000);
      const offset = dayOfYear % repos.length;
      repos = repos.slice(offset).concat(repos.slice(0, offset));
    }

    log(`repos: ${repos.map((r) => r.name).join(', ')}`);
    const deadline = Date.now() + CONFIG.globalDeadlineMs;

    // Circuit-breaker state. See the abort block below.
    let consecutiveEnvFaults = 0;
    const ENV_FAULT_LIMIT = CONFIG.envFaultAbortAfter ?? 2;

    for (const repo of repos) {
      if (Date.now() > deadline) {
        log('global deadline reached, stopping');
        results.push({ repo: repo.name, branch: repo.branch, status: 'skipped-deadline', deferred: [], preexistingDirty: 0 });
        continue;
      }
      if (CONFIG.nightlyCostCapUsd && SPEND.total >= CONFIG.nightlyCostCapUsd) {
        log(`cost cap $${CONFIG.nightlyCostCapUsd} reached (spent $${SPEND.total.toFixed(2)}), stopping`);
        results.push({ repo: repo.name, branch: repo.branch, status: 'skipped-cost-cap', deferred: [], preexistingDirty: 0 });
        continue;
      }
      let outcome;
      try {
        outcome = processRepo(repo);
      } catch (err) {
        log(`  UNCAUGHT in ${repo.name}: ${err.message}`);
        outcome = {
          repo: repo.name, branch: repo.branch, status: 'crashed',
          error: err.message, envFault: isEnvironmentFault(err.message),
          deferred: [], preexistingDirty: 0,
        };
      }
      results.push(outcome);

      // Circuit breaker. On 2026-08-07 a single machine-level fault at 02:08:13
      // was recorded as 12 consecutive repo failures in 400ms, each reading like
      // that repo's own fault. Consecutive environment faults mean the machine is
      // broken, so stop, say so once, and leave the untouched repos untouched
      // rather than burning the rota and the cost cap on certain failures.
      if (outcome.envFault) {
        consecutiveEnvFaults += 1;
        if (consecutiveEnvFaults >= ENV_FAULT_LIMIT) {
          const readable = documentsReadable();
          log(`ABORTING: ${consecutiveEnvFaults} consecutive environment faults. ` +
              `${CONFIG.rootDir} is ${readable ? 'readable again, so the fault is inside the claude spawn path' : 'NOT readable: the TCC grant for this job is gone'}.`);
          abortedReason =
            `Stopped after ${consecutiveEnvFaults} consecutive environment faults. ` +
            `${CONFIG.rootDir} was ${readable ? 'still readable from the runner, so the fault is in the claude spawn path, not a blanket TCC denial' : 'unreadable from the runner, so this job had lost its Files and Folders grant'}. ` +
            'The repos below this point were not attempted and are not failing.';
          break;
        }
      } else {
        consecutiveEnvFaults = 0;
      }
    }
  } finally {
    try { rmSync(lockPath, { force: true }); } catch { /* best effort */ }
  }

  writeReport(results, abortedReason);
  log('=== nightly hygiene done ===');
}

// Only run when invoked as a script, so the tests can import the classifier
// without starting a live 14-repo pass. realpath both sides so nvm shims and
// symlinked paths still compare equal.
function invokedDirectly() {
  try {
    return process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return true; // a resolution failure must never silently disable the nightly job
  }
}

if (invokedDirectly()) main();

export { isEnvironmentFault };
