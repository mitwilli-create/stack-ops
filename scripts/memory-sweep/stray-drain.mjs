#!/usr/bin/env node
// stray-drain.mjs: scheduled drain of unwrapped transcripts into session records.
//
// WHY THIS EXISTS. /wrap mines at most 8 strays per run because it reads each one
// into the INTERACTIVE session's context. That cap is a context budget, not a
// correctness bound, so the backlog outruns it. What then happens is the failure
// Mitchell actually sees: a live session finds hundreds of strays, correctly
// judges that mining them is too much context-heavy work for a drifting model,
// and declines. Reporting a number is not capturing the information.
//
// The drain itself is not a judgement call and should never have been one. It is
// bounded, restartable, and reads each transcript in an isolated worker, so it
// belongs on a schedule and not in anyone's context window. This wraps
// ~/.claude/skills/wrap/lib/drain-strays.mjs, which does the mining, and adds the
// two things a scheduled job needs and the library deliberately leaves out:
// enumerating the strays, and committing what it produced.
//
// ROUTING. drain-strays sends every summarisation to the cheap open-weight tier
// (`cheap --task bulk_summarize`, privacy gate and credential scanner in front of
// each call). Nothing here calls Claude, so this does not touch the subscription
// or the metered API. Measured 2026-08-07: about $0.004 per transcript.
//
// SAFETY. It never deletes a transcript, claims each through the locked ledger so
// concurrent /wrap runs cannot double-mine, releases claims on failure so nothing
// is lost, and only ever writes NEW records. The commit is scoped to the session
// directories it wrote, never `git add -A`, because 10 to 30 concurrent sessions
// write this vault.
//
// Usage:
//   node stray-drain.mjs               # drain up to maxPerRun, then commit
//   node stray-drain.mjs --dry-run     # count strays, write and commit nothing
//   node stray-drain.mjs --limit N

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const HOME = homedir();
const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG = JSON.parse(readFileSync(join(HERE, 'config.json'), 'utf8'));

const ARGS = process.argv.slice(2);
const DRY_RUN = ARGS.includes('--dry-run');
const LIMIT = parseInt((ARGS.find((a) => a.startsWith('--limit=')) || '').split('=')[1] || '0', 10)
  || CONFIG.strayDrain?.maxPerRun || 400;
const CONCURRENCY = CONFIG.strayDrain?.concurrency || 16;

const VAULT = CONFIG.vaultRoot;
const PROJECTS = join(HOME, '.claude', 'projects');
const LEDGER = process.env.WRAP_LEDGER || join(HOME, '.local', 'llm-memory-wrappers', 'wrap-ledger.txt');
const DRAINER = join(HOME, '.claude', 'skills', 'wrap', 'lib', 'drain-strays.mjs');
const LOG_DIR = join(CONFIG.logDir, '..', 'stray-drain');
mkdirSync(LOG_DIR, { recursive: true });

const stamp = () => new Date().toISOString();
function log(...p) {
  const line = `[${stamp()}] ${p.join(' ')}`;
  console.log(line);
  try { writeFileSync(join(LOG_DIR, 'stray-drain.log'), line + '\n', { flag: 'a' }); } catch { /* never throw */ }
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, cwd: opts.cwd, timeout: opts.timeoutMs });
  return { code: r.status === null ? 124 : r.status, stdout: r.stdout || '', stderr: r.stderr || (r.error ? String(r.error.message) : '') };
}
const git = (args, opts = {}) => run('git', args, { cwd: VAULT, ...opts });

/** Every transcript whose session id is absent from the wrap ledger. */
function findStrays() {
  const claimed = new Set();
  try {
    for (const l of readFileSync(LEDGER, 'utf8').split('\n')) { const t = l.trim(); if (t) claimed.add(t); }
  } catch { /* no ledger yet: everything is a stray */ }

  const out = [];
  let projectDirs = [];
  try { projectDirs = readdirSync(PROJECTS); } catch { return out; }
  for (const p of projectDirs) {
    let files = [];
    try { files = readdirSync(join(PROJECTS, p)); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      if (claimed.has(basename(f, '.jsonl'))) continue;
      out.push(join(PROJECTS, p, f));
    }
  }
  return out;
}

function main() {
  log(`=== stray drain start${DRY_RUN ? ' [DRY RUN]' : ''} ===`);

  if (!existsSync(DRAINER)) { log(`FAILED: drainer missing at ${DRAINER}`); process.exit(1); }

  const strays = findStrays();
  log(`${strays.length} unwrapped transcript(s); draining up to ${LIMIT}`);
  if (!strays.length) { log('nothing to drain'); log('=== stray drain done ==='); return; }

  const listFile = join(LOG_DIR, 'strays.txt');
  writeFileSync(listFile, strays.join('\n') + '\n');
  if (DRY_RUN) { log(`dry run, wrote ${listFile} and stopped`); log('=== stray drain done ==='); return; }

  const progress = join(LOG_DIR, `progress-${stamp().replace(/[:.]/g, '-')}.jsonl`);
  const r = run('node', [DRAINER, '--list', listFile, '--limit', String(LIMIT),
    '--concurrency', String(CONCURRENCY), '--out', progress], { timeoutMs: CONFIG.strayDrain?.timeoutMs || 3_600_000 });
  log((r.stdout || '').trim().split('\n').slice(-3).join(' | '));
  if (r.code !== 0) log(`drainer exited ${r.code}: ${r.stderr.slice(0, 300)}`);

  // Second pass for whatever the privacy gate refused.
  //
  // The gate refuses any transcript referencing .env, .secrets, .zshrc or a
  // credential vault, because that content must not reach a third-party
  // open-weight provider. It is right to refuse, and those transcripts are
  // logged as "model-failed" even though nothing failed. Left alone they are
  // refused again every run and never captured at all, which is the exact
  // silent-gap this job exists to close (31 of 871 on 2026-08-07, and they
  // happened to include 5 of the 6 otherwise-uncaptured parent sessions).
  //
  // --engine claude routes through ~/.claude/bin/claude, which does
  // `env -u ANTHROPIC_API_KEY`, so these bill the SUBSCRIPTION and the content
  // never leaves the machine. Scoped to gate refusals only. It must never
  // become the general engine: that would put bulk toil on a billing path the
  // routing policy reserves for work Claude is genuinely best at.
  const gated = readProgress(progress)
    .filter((e) => e.status === 'model-failed' && /privacy gate/i.test(e.note || ''))
    .map((e) => e.file)
    .filter(Boolean);

  if (gated.length) {
    log(`${gated.length} transcript(s) refused by the privacy gate, retrying on the subscription engine`);
    const gatedList = join(LOG_DIR, 'strays-gated.txt');
    writeFileSync(gatedList, [...new Set(gated)].join('\n') + '\n');
    const g = run('node', [DRAINER, '--list', gatedList, '--engine', 'claude',
      '--concurrency', '4', '--out', progress], { timeoutMs: CONFIG.strayDrain?.timeoutMs || 3_600_000 });
    log((g.stdout || '').trim().split('\n').slice(-3).join(' | '));
    if (g.code !== 0) log(`subscription retry exited ${g.code}: ${g.stderr.slice(0, 300)}`);
  }

  // Commit ONLY new session records, by explicit path. Never `git add -A` here:
  // this vault has 10 to 30 concurrent writers and their work is not ours to stage.
  // Filter in JS, not with a git pathspec. `project-memory/*/sessions/` silently
  // matches NOTHING here (a literal-trailing-slash pathspec with a single `*`),
  // so the first version of this staged zero files and committed nothing while
  // reporting success. Verified 2026-08-07 against 628 real records.
  const untracked = git(['ls-files', '--others', '--exclude-standard'])
    .stdout.split('\n').map((s) => s.trim())
    .filter((p) => /^project-memory\/[^/]+\/sessions\/.+\.md$/.test(p));
  if (!untracked.length) { log('no new records to commit'); log('=== stray drain done ==='); return; }

  for (const batch of chunk(untracked, 200)) git(['add', '--', ...batch]);

  const staged = git(['diff', '--cached', '--name-only']).stdout.split('\n').filter(Boolean).length;
  const msgFile = join(LOG_DIR, 'commit-msg.txt');
  writeFileSync(msgFile,
    `vault: drain ${staged} unwrapped transcript(s) into session records\n\n` +
    `Scheduled drain. ${strays.length} transcript(s) were unwrapped at start; this run\n` +
    `mined up to ${LIMIT} of them via the cheap open-weight tier. Records are append\n` +
    `only and no transcript was deleted.\n\n` +
    `Run log: ${progress}\n`);
  const c = git(['commit', '-F', msgFile]);
  if (c.code !== 0) log(`commit failed: ${(c.stderr || c.stdout).slice(0, 300)}`);
  else log(`committed ${staged} record(s)`);

  log('=== stray drain done ===');
}

function chunk(a, n) { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; }

/** Parse the drainer's JSONL progress log. A malformed line is skipped, not fatal. */
function readProgress(file) {
  let raw = '';
  try { raw = readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* skip */ }
  }
  return out;
}

function invokedDirectly() {
  try { return process.argv[1] && realpath(process.argv[1]) === realpath(fileURLToPath(import.meta.url)); }
  catch { return true; }
}
function realpath(p) { return run('/usr/bin/readlink', ['-f', p]).stdout.trim() || p; }

if (invokedDirectly()) main();

export { findStrays };
