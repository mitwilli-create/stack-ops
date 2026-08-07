#!/usr/bin/env node
// memory-sweep.mjs: scheduled reasoning-based maintenance of the memory vault.
//
// Runs every 6h. Per project: ask a model for a typed PLAN, validate every
// operation, apply the valid ones mechanically, verify, commit.
//
// The trust property that makes this safe to run unattended:
//
//   THE MODEL NEVER WRITES TO THE VAULT. It returns operations from a closed set
//   (merge_facts, supersede, rewrite_index, compact_sessions). This script
//   validates each one and performs the file operations itself. An operation this
//   script cannot validate does not happen.
//
// Other load-bearing invariants:
//
//  * A file is eligible only if TRACKED and CLEAN in git. Untracked files are not
//    git-recoverable if a merge is wrong; dirty files belong to one of the 10-30
//    concurrent sessions writing this vault. Both are skipped and reported.
//  * A fact file is NEVER deleted. A merged one becomes a tombstone pointing at
//    the canonical file, so every existing [[link]] still resolves.
//  * Session records are deleted from the worktree on compaction ONLY because all
//    of them are git-tracked, so history remains the audit trail. Verified
//    2026-08-06: 0 of 848 untracked. The script re-checks this per record.
//  * Every candidate body passes the secret scanner before it reaches disk.
//  * Every rewritten index must have all pointers resolve, and must land under its
//    byte TARGET, before it is installed.
//
// TCC note: node is the launchd entrypoint because TCC grants are per-binary.
// /bin/zsh under launchd is DENIED ~/Documents; node at its absolute path is
// GRANTED, and children it spawns inherit the grant. Probed 2026-08-06.
//
// Usage:
//   node memory-sweep.mjs                  # full sweep
//   node memory-sweep.mjs --dry-run        # plan and validate, apply nothing
//   node memory-sweep.mjs --projects a,b   # subset
//   node memory-sweep.mjs --layers indices # comma list: indices,facts,sessions

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, statSync, realpathSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG = JSON.parse(readFileSync(join(HERE, 'config.json'), 'utf8'));
const PROMPT_TEMPLATE = readFileSync(join(HERE, 'prompt.md'), 'utf8');
const SECRET_SCAN = join(process.env.HOME, '.claude/skills/wrap/lib/secret-scan.mjs');

const ARGS = process.argv.slice(2);
const DRY_RUN = ARGS.includes('--dry-run');
const ONLY = (ARGS.find((a) => a.startsWith('--projects=')) || '').split('=')[1];
const LAYER_ARG = (ARGS.find((a) => a.startsWith('--layers=')) || '').split('=')[1];
const LAYERS = LAYER_ARG
  ? Object.fromEntries(['indices', 'facts', 'sessions'].map((k) => [k, LAYER_ARG.split(',').includes(k)]))
  : CONFIG.layers;

const V = CONFIG.vaultRoot;
const PM = join(V, 'project-memory');
const STARTED_AT = new Date();
const RUN_ID = STARTED_AT.toISOString().replace(/[:.]/g, '-');
const RUN_LOG_DIR = join(CONFIG.logDir, RUN_ID);
mkdirSync(RUN_LOG_DIR, { recursive: true });

const SPEND = { total: 0 };

// Paths that must never be read into a prompt or written by an operation.
const PERSONAL = [
  /(^|\/)cv\.md$/i, /(^|\/)applications\.md$/i, /(^|\/)hm-intel(\/|$)/i,
  /(^|\/)apply-pack(\/|$)/i, /(^|\/)interview-prep(\/|$)/i, /(^|\/)\.env($|\.)/i,
];
const isPersonal = (p) => PERSONAL.some((re) => re.test(p));

// ---------------------------------------------------------------- utilities

function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(' ')}`;
  console.log(line);
  try { writeFileSync(join(CONFIG.logDir, 'memory-sweep.log'), line + '\n', { flag: 'a' }); } catch { /* never throw */ }
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    timeout: opts.timeoutMs, cwd: opts.cwd,
    env: { ...process.env, ...(opts.env || {}) },
  });
  return {
    code: r.status === null ? 124 : r.status,
    stdout: r.stdout || '', stderr: r.stderr || (r.error ? String(r.error.message) : ''),
    timedOut: r.status === null,
  };
}
const git = (args, opts = {}) => run('git', args, { cwd: V, ...opts });

/** Repo-relative path for a vault-absolute path. */
const rel = (abs) => abs.startsWith(V + '/') ? abs.slice(V.length + 1) : abs;

/** A file is eligible only if tracked AND clean. Both checks matter, see header. */
function isEligible(abs) {
  const r = rel(abs);
  if (git(['ls-files', '--error-unmatch', '--', r]).code !== 0) return { ok: false, why: 'untracked (not git-recoverable)' };
  if (git(['diff', '--quiet', '--', r]).code !== 0) return { ok: false, why: 'modified by another session' };
  if (git(['diff', '--cached', '--quiet', '--', r]).code !== 0) return { ok: false, why: 'staged by another session' };
  return { ok: true };
}

/** Fail closed: a scanner that cannot run means the content does not land. */
function scanClean(text) {
  const tmp = join(RUN_LOG_DIR, `.scan-${Math.abs(hash(text))}.tmp`);
  writeFileSync(tmp, text);
  const r = run('node', [SECRET_SCAN, tmp]);
  try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
  return r.code === 0;
}
function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; } return h; }

// Em dashes are banned standing policy ("scrub on sight, never ask"). The existing
// corpus is full of them, so REJECTING a body for containing one would permanently
// block every faithful rewrite: the model preserves content, content has dashes,
// operation dies. Found by the 2026-08-06 pilot, whose only operation was rejected
// for exactly this. Normalize instead, and scrub on the way in.
function scrubDashes(s) {
  return s.replace(/\s*[\u2014\u2013]\s*/g, (m) => (/\n/.test(m) ? m.replace(/[\u2014\u2013]/, ',') : ', '));
}
function normalizeOp(op) {
  if (!op || typeof op !== 'object') return op;
  for (const k of ['new_body', 'digest_body']) {
    if (typeof op[k] === 'string') op[k] = scrubDashes(op[k]);
  }
  return op;
}

// ------------------------------------------------------- billing preflight

function preflightBilling() {
  const problems = [];
  if (!existsSync(CONFIG.claudeBin)) problems.push(`claudeBin missing: ${CONFIG.claudeBin}`);
  else {
    let body = '';
    try { body = readFileSync(CONFIG.claudeBin, 'utf8'); } catch { /* handled */ }
    if (!body.includes('env -u ANTHROPIC_API_KEY')) {
      problems.push(`${CONFIG.claudeBin} does not strip ANTHROPIC_API_KEY; it would bill the metered API`);
    }
  }
  if (run('/usr/bin/security', ['find-generic-password', '-s', 'Claude Code-credentials']).code !== 0) {
    problems.push('no subscription credential in the keychain');
  }
  return problems;
}

// ------------------------------------------------------------ gathering

function budgetOf(bytes, target, cap) {
  return bytes <= target ? 'OK' : bytes <= cap ? 'OVER_TARGET' : 'OVER_CAP';
}

function gatherProject(project) {
  const dir = join(PM, project);
  const memPath = join(dir, 'MEMORY.md');
  const sessIdxPath = join(dir, 'SESSIONS.md');
  const sessDir = join(dir, 'sessions');

  const memBytes = existsSync(memPath) ? statSync(memPath).size : 0;
  const sessIdxBytes = existsSync(sessIdxPath) ? statSync(sessIdxPath).size : 0;

  const facts = [], factsSkipped = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.md'))) {
    if (['MEMORY.md', 'SESSIONS.md'].includes(f)) continue;
    const abs = join(dir, f);
    if (isPersonal(abs)) { factsSkipped.push({ file: f, why: 'personal data, never read' }); continue; }
    const e = isEligible(abs);
    if (!e.ok) { factsSkipped.push({ file: f, why: e.why }); continue; }
    facts.push({ file: f, bytes: statSync(abs).size, abs });
  }

  const oldSessions = [], sessionsSkipped = [];
  const cutoff = Date.now() - CONFIG.sessionCompaction.olderThanDays * 86400000;
  if (existsSync(sessDir)) {
    for (const f of readdirSync(sessDir).filter((n) => n.endsWith('.md'))) {
      const abs = join(sessDir, f);
      const st = statSync(abs);
      if (st.mtimeMs > cutoff) continue;
      const e = isEligible(abs);
      if (!e.ok) { sessionsSkipped.push({ file: f, why: e.why }); continue; }
      oldSessions.push({ file: f, bytes: st.size, abs });
    }
  }

  return {
    project, dir, memPath, sessIdxPath, sessDir,
    memBytes, sessIdxBytes,
    memStatus: budgetOf(memBytes, CONFIG.budgets.memoryTargetBytes, CONFIG.budgets.memoryCapBytes),
    facts, factsSkipped, oldSessions, sessionsSkipped,
  };
}

// --------------------------------------------------------- the model pass

function buildPrompt(g) {
  const inv = g.facts.map((f) => {
    let first = '';
    try {
      first = readFileSync(f.abs, 'utf8').split('\n')
        .filter((l) => l.trim() && !l.startsWith('---') && !/^\w+:/.test(l) && !l.startsWith('#'))[0] || '';
    } catch { /* unreadable, leave blank */ }
    return `${f.file}\t${f.bytes}B\t${first.slice(0, 160)}`;
  }).join('\n') || '(none eligible)';

  const sInv = g.oldSessions.map((s) => `${s.file}\t${s.bytes}B`).join('\n') || '(none eligible)';
  let memBody = '';
  try { memBody = readFileSync(g.memPath, 'utf8'); } catch { memBody = '(absent)'; }

  return PROMPT_TEMPLATE
    .replaceAll('{{PROJECT}}', g.project)
    .replaceAll('{{MEMORY_BYTES}}', String(g.memBytes))
    .replaceAll('{{MEMORY_TARGET}}', String(CONFIG.budgets.memoryTargetBytes))
    .replaceAll('{{MEMORY_CAP}}', String(CONFIG.budgets.memoryCapBytes))
    .replaceAll('{{MEMORY_STATUS}}', g.memStatus)
    .replaceAll('{{SESSIONS_BYTES}}', String(g.sessIdxBytes))
    .replaceAll('{{FACT_COUNT}}', String(g.facts.length))
    .replaceAll('{{SESSION_AGE}}', String(CONFIG.sessionCompaction.olderThanDays))
    .replaceAll('{{OLD_SESSION_COUNT}}', String(g.oldSessions.length))
    .replaceAll('{{MEMORY_BODY}}', memBody)
    .replaceAll('{{FACT_INVENTORY}}', inv)
    .replaceAll('{{SESSION_INVENTORY}}', sInv);
}

function askForPlan(g) {
  const args = [
    '-p', buildPrompt(g),
    '--output-format', 'json',
    '--permission-mode', 'acceptEdits',
    '--model', CONFIG.model,
    '--effort', CONFIG.effort,
    '--disallowedTools', 'Write,Edit,NotebookEdit',   // belt and braces: it returns a plan, it does not edit
  ];
  const r = run(CONFIG.claudeBin, args, {
    cwd: g.dir, timeoutMs: CONFIG.perProjectTimeoutMs, env: { ANTHROPIC_API_KEY: '' },
  });
  writeFileSync(join(RUN_LOG_DIR, `${g.project}.plan.json`), r.stdout || r.stderr || '');
  if (r.timedOut) return { ok: false, error: `timed out after ${CONFIG.perProjectTimeoutMs}ms` };
  if (r.code !== 0) return { ok: false, error: `claude exited ${r.code}: ${r.stderr.slice(0, 300)}` };

  try {
    const env = JSON.parse(r.stdout);
    SPEND.total += Number(env.total_cost_usd) || 0;
    const text = typeof env.result === 'string' ? env.result : r.stdout;
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return { ok: false, error: 'no JSON plan in response' };
    return { ok: true, plan: JSON.parse(m[0]), costUsd: Number(env.total_cost_usd) || 0 };
  } catch (e) {
    return { ok: false, error: `unparseable plan: ${e.message}` };
  }
}

// ------------------------------------------------------- validate + apply

/** Every pointer of the form ](target) must resolve inside the project dir. */
function pointersResolve(dir, body) {
  const bad = [];
  for (const m of body.matchAll(/\]\(([^)]+)\)/g)) {
    const t = m[1];
    if (/^(https?:|#|mailto:)/.test(t)) continue;
    if (!existsSync(join(dir, t))) bad.push(t);
  }
  return bad;
}

function validateOp(g, op) {
  const bad = (why) => ({ ok: false, why });
  if (!op || typeof op !== 'object') return bad('not an object');

  const bodies = [op.new_body, op.digest_body].filter((b) => typeof b === 'string');
  for (const b of bodies) {
    // Dashes are already scrubbed by normalizeOp; assert it held rather than trusting it.
    if (/[\u2014\u2013]/.test(b)) return bad('body still contains an em or en dash after scrubbing');
    if (!scanClean(b)) return bad('body failed the secret scan (or scanner unavailable: fail closed)');
  }

  const eligible = (name, list) => list.some((x) => x.file === name);

  switch (op.op) {
    case 'merge_facts': {
      if (!LAYERS.facts) return bad('facts layer disabled');
      if (typeof op.into !== 'string' || !Array.isArray(op.from) || !op.from.length) return bad('malformed');
      if (typeof op.new_body !== 'string' || !op.new_body.trim()) return bad('empty new_body');
      for (const n of [op.into, ...op.from]) {
        if (n.includes('/') || !n.endsWith('.md')) return bad(`bad filename ${n}`);
        if (isPersonal(join(g.dir, n))) return bad(`personal file ${n}`);
      }
      if (op.from.includes(op.into)) return bad('into listed in from');
      for (const n of op.from) if (!eligible(n, g.facts)) return bad(`${n} not eligible`);
      if (existsSync(join(g.dir, op.into)) && !eligible(op.into, g.facts)) return bad(`${op.into} not eligible`);

      // Compression floor. The first live run (2026-08-06) merged 4 files of 8733
      // bytes into 1287, an 85% cut, while claiming "without losing any fact". It
      // had dropped detail ("Composer" from the flat-rate routing rule). Merging
      // duplicates should remove REPETITION, not content, so a body far smaller
      // than its sources is summarising rather than merging. Reject and let it
      // retry with a narrower merge.
      let sourceBytes = 0;
      for (const n of op.from) {
        try { sourceBytes += statSync(join(g.dir, n)).size; } catch { /* counted as 0 */ }
      }
      if (existsSync(join(g.dir, op.into))) {
        try { sourceBytes += statSync(join(g.dir, op.into)).size; } catch { /* counted as 0 */ }
      }
      const floor = CONFIG.mergeCompressionFloor ?? 0.4;
      const kept = sourceBytes ? Buffer.byteLength(op.new_body) / sourceBytes : 1;
      if (kept < floor) {
        return bad(`merge keeps only ${Math.round(kept * 100)}% of ${sourceBytes}B of sources (floor ${Math.round(floor * 100)}%): summarising, not merging`);
      }
      return { ok: true };
    }
    case 'supersede': {
      if (!LAYERS.facts) return bad('facts layer disabled');
      for (const n of [op.old, op.new]) {
        if (typeof n !== 'string' || n.includes('/') || !n.endsWith('.md')) return bad('bad filename');
      }
      if (!eligible(op.old, g.facts)) return bad(`${op.old} not eligible`);
      if (!existsSync(join(g.dir, op.new))) return bad(`${op.new} does not exist`);
      return { ok: true };
    }
    case 'rewrite_index': {
      if (!LAYERS.indices) return bad('indices layer disabled');
      if (!['MEMORY.md', 'SESSIONS.md'].includes(op.file)) return bad('file must be MEMORY.md or SESSIONS.md');
      if (typeof op.new_body !== 'string' || !op.new_body.trim()) return bad('empty new_body');
      const abs = join(g.dir, op.file);
      if (existsSync(abs)) { const e = isEligible(abs); if (!e.ok) return bad(e.why); }
      const broken = pointersResolve(g.dir, op.new_body);
      if (broken.length) return bad(`pointers do not resolve: ${broken.slice(0, 3).join(', ')}`);
      const size = Buffer.byteLength(op.new_body);
      const target = op.file === 'MEMORY.md' ? CONFIG.budgets.memoryTargetBytes : CONFIG.budgets.sessionsTargetBytes;
      if (size > target) return bad(`still over target after rewrite (${size} > ${target})`);
      return { ok: true };
    }
    case 'compact_sessions': {
      if (!LAYERS.sessions) return bad('sessions layer disabled');
      if (!/^\d{4}-\d{2}$/.test(op.month || '')) return bad('bad month');
      if (!Array.isArray(op.records) || op.records.length < CONFIG.sessionCompaction.minRecordsPerMonth) {
        return bad(`fewer than ${CONFIG.sessionCompaction.minRecordsPerMonth} records, not worth compacting`);
      }
      if (typeof op.digest_body !== 'string' || !op.digest_body.trim()) return bad('empty digest_body');
      for (const n of op.records) {
        if (typeof n !== 'string' || n.includes('/') || !n.endsWith('.md')) return bad(`bad record name ${n}`);
        if (!eligible(n, g.oldSessions)) return bad(`${n} not eligible`);
        // Deleting is only acceptable because git holds the original. Re-verify per record.
        if (git(['ls-files', '--error-unmatch', '--', rel(join(g.sessDir, n))]).code !== 0) {
          return bad(`${n} not in git; refusing to delete an unrecoverable record`);
        }
      }
      return { ok: true };
    }
    default:
      return bad(`unknown op ${op.op}`);
  }
}

function applyOp(g, op) {
  const written = [];
  switch (op.op) {
    case 'merge_facts': {
      writeFileSync(join(g.dir, op.into), op.new_body);
      written.push(join(g.dir, op.into));
      for (const n of op.from) {
        // Tombstone, never deletion: existing [[links]] must keep resolving.
        const tomb = [
          '---', `name: ${n.replace(/\.md$/, '')}`,
          `description: merged into ${op.into} by the memory sweep on ${STARTED_AT.toISOString().slice(0, 10)}`,
          'metadata:', '  type: reference', `  superseded_by: ${op.into}`, '---', '',
          `This memory was merged into [[${op.into.replace(/\.md$/, '')}]].`, '',
          `Reason: ${op.why || 'duplicate content'}`, '',
          `The full original text is in git history before the sweep commit of ${STARTED_AT.toISOString().slice(0, 10)}.`, '',
        ].join('\n');
        writeFileSync(join(g.dir, n), tomb);
        written.push(join(g.dir, n));
      }
      return written;
    }
    case 'supersede': {
      const abs = join(g.dir, op.old);
      let body = readFileSync(abs, 'utf8');
      if (!/superseded_by:/.test(body)) {
        body = body.replace(/^---\n([\s\S]*?)\n---/, (m0, fm) =>
          `---\n${fm}\n  superseded_by: ${op.new}\n---`);
        body += `\n\n> Superseded by [[${op.new.replace(/\.md$/, '')}]] on ${STARTED_AT.toISOString().slice(0, 10)}. ${op.why || ''}\n`;
        writeFileSync(abs, body);
        written.push(abs);
      }
      return written;
    }
    case 'rewrite_index': {
      const abs = join(g.dir, op.file);
      writeFileSync(abs, op.new_body);
      written.push(abs);
      return written;
    }
    case 'compact_sessions': {
      const digest = join(g.sessDir, `${op.month}-digest.md`);
      writeFileSync(digest, op.digest_body);
      written.push(digest);
      for (const n of op.records) {
        rmSync(join(g.sessDir, n), { force: true });   // recoverable: verified tracked in validate
        written.push(join(g.sessDir, n));
      }
      return written;
    }
    default:
      return written;
  }
}

// ------------------------------------------------------------ per project

function sweepProject(project) {
  const out = { project, applied: [], rejected: [], skippedFiles: [], costUsd: 0, status: 'pending', error: null };
  log(`--- ${project} ---`);

  const g = gatherProject(project);
  out.skippedFiles = [...g.factsSkipped, ...g.sessionsSkipped];
  out.memBefore = g.memBytes;

  const nothingToDo = g.memStatus === 'OK' && g.facts.length < 2 && g.oldSessions.length === 0;
  if (nothingToDo) { out.status = 'nothing-to-do'; log('  nothing to do'); return out; }

  // Cost control that actually bites: skip a project whose memory has not changed
  // since the last sweep. At ~$0.45 per project, sweeping all 15 four times a day
  // would run ~$27/day; in practice most projects are untouched between runs and
  // cost nothing. A project still gets a forced pass every forceAfterHours so a
  // stale index cannot hide behind "unchanged" forever.
  const stateFile = join(CONFIG.logDir, 'last-swept.json');
  let state = {};
  try { state = JSON.parse(readFileSync(stateFile, 'utf8')); } catch { /* first run */ }
  const prev = state[project];
  if (prev?.sha && !DRY_RUN) {
    const changed = git(['log', '--oneline', `${prev.sha}..HEAD`, '--', `project-memory/${project}`]);
    const ageH = (Date.now() - (prev.at || 0)) / 3600000;
    const forceAfter = CONFIG.forceAfterHours ?? 168;
    if (changed.code === 0 && !changed.stdout.trim() && ageH < forceAfter) {
      out.status = 'unchanged-skipped';
      log(`  unchanged since ${prev.sha.slice(0, 8)} (${ageH.toFixed(0)}h ago), skipping`);
      return out;
    }
  }
  out._stateFile = stateFile;
  out._state = state;

  const res = askForPlan(g);
  out.costUsd = res.costUsd || 0;
  if (!res.ok) { out.status = 'plan-failed'; out.error = res.error; log(`  FAILED: ${res.error}`); return out; }
  if (out.costUsd) log(`  cost $${out.costUsd.toFixed(2)} (run total $${SPEND.total.toFixed(2)})`);

  const ops = Array.isArray(res.plan?.operations) ? res.plan.operations : [];
  if (!ops.length) { out.status = 'no-operations'; log('  model proposed nothing'); return out; }

  const written = [];
  for (const rawOp of ops) {
    const op = normalizeOp(rawOp);
    const v = validateOp(g, op);
    if (!v.ok) { out.rejected.push({ op: op?.op, why: v.why }); log(`  REJECTED ${op?.op}: ${v.why}`); continue; }
    if (DRY_RUN) { out.applied.push({ op: op.op, why: op.why, dryRun: true }); continue; }
    try {
      written.push(...applyOp(g, op));
      out.applied.push({ op: op.op, why: op.why });
      log(`  applied ${op.op}: ${op.why || ''}`);
    } catch (e) {
      out.rejected.push({ op: op.op, why: `apply threw: ${e.message}` });
    }
  }

  if (DRY_RUN) { out.status = 'dry-run'; return out; }
  if (!written.length) { out.status = 'all-rejected'; return out; }

  // Post-verify: MEMORY.md must actually be under target and its pointers resolve.
  const memNow = existsSync(g.memPath) ? statSync(g.memPath).size : 0;
  out.memAfter = memNow;
  const broken = existsSync(g.memPath) ? pointersResolve(g.dir, readFileSync(g.memPath, 'utf8')) : [];
  if (broken.length) {
    git(['checkout', '--', ...written.map(rel)]);
    out.status = 'verify-failed-reverted';
    out.error = `broken pointers after apply: ${broken.slice(0, 3).join(', ')}`;
    log(`  REVERTED: ${out.error}`);
    return out;
  }

  const staged = [...new Set(written.map(rel))];
  if (git(['add', '--', ...staged]).code !== 0) {
    out.status = 'add-failed'; out.error = 'git add failed'; return out;
  }
  const msg = [
    `memory-sweep(${project}): ${out.applied.map((a) => a.op).join(', ')}`,
    '',
    ...out.applied.map((a) => `- ${a.op}: ${a.why || ''}`),
    '',
    `MEMORY.md ${out.memBefore} -> ${memNow} bytes. Run ${RUN_ID}.`,
    'Originals recoverable in git history before this commit.',
  ].join('\n');
  const c = git(['commit', '--only', '-m', msg, '--', ...staged]);
  if (c.code !== 0) {
    out.status = 'commit-failed'; out.error = c.stderr.slice(0, 200);
    git(['reset', 'HEAD', '--', ...staged]);
    git(['checkout', '--', ...staged]);
    return out;
  }
  out.status = 'committed';
  const full = git(['rev-parse', 'HEAD']).stdout.trim();
  out.sha = full.slice(0, 8);
  if (out._stateFile) {
    try {
      out._state[project] = { sha: full, at: Date.now() };
      writeFileSync(out._stateFile, JSON.stringify(out._state, null, 1));
    } catch { /* state is an optimisation, never fatal */ }
  }
  log(`  committed ${out.sha}, MEMORY.md ${out.memBefore} -> ${memNow}`);
  return out;
}

// ------------------------------------------------------------------ report

function writeReport(results) {
  const mins = Math.round((new Date() - STARTED_AT) / 60000);
  const L = [];
  L.push(`# Memory sweep, ${STARTED_AT.toISOString().slice(0, 16).replace('T', ' ')} UTC`);
  L.push('');
  L.push(`${results.length} projects in ${mins} min. Cost $${SPEND.total.toFixed(2)} (cap $${CONFIG.sweepCostCapUsd}). Run \`${RUN_ID}\`.`);
  L.push('');
  L.push('| Project | Outcome | Ops applied | Rejected | MEMORY.md |');
  L.push('|---|---|---|---|---|');
  for (const r of results) {
    const mem = r.memBefore !== undefined ? `${r.memBefore}${r.memAfter !== undefined ? ` -> ${r.memAfter}` : ''}` : '-';
    L.push(`| ${r.project} | ${r.status} | ${r.applied.length} | ${r.rejected.length} | ${mem} |`);
  }
  L.push('');

  const rej = results.filter((r) => r.rejected.length);
  if (rej.length) {
    L.push('## Operations the validator refused');
    L.push('');
    L.push('These are the guardrail working, not errors to fix by hand.');
    L.push('');
    for (const r of rej) for (const x of r.rejected) L.push(`- **${r.project}** \`${x.op}\`: ${x.why}`);
    L.push('');
  }

  const skipped = results.filter((r) => r.skippedFiles.length);
  if (skipped.length) {
    L.push('## Files skipped as ineligible');
    L.push('');
    L.push('Untracked files are not git-recoverable, so they are never rewritten. Commit them to bring them into scope.');
    L.push('');
    for (const r of skipped) for (const x of r.skippedFiles.slice(0, 8)) L.push(`- \`${r.project}/${x.file}\`: ${x.why}`);
    L.push('');
  }

  const errs = results.filter((r) => r.error);
  if (errs.length) {
    L.push('## Needs your eye');
    L.push('');
    for (const r of errs) L.push(`- **${r.project}** (${r.status}): ${r.error}`);
    L.push('');
  }

  L.push('## Undoing this run');
  L.push('');
  L.push('Every project commits separately, titled `memory-sweep(<project>)`.');
  L.push('');
  L.push('```sh');
  L.push(`git -C ${V} log --oneline --grep="memory-sweep" -20`);
  L.push(`git -C ${V} revert <sha>   # any single project's sweep`);
  L.push('```');

  const md = L.join('\n');
  writeFileSync(join(CONFIG.logDir, 'latest-report.md'), md);
  writeFileSync(join(RUN_LOG_DIR, 'report.md'), md);
  writeFileSync(join(RUN_LOG_DIR, 'report.json'), JSON.stringify({ runId: RUN_ID, results, spend: SPEND.total }, null, 2));
  log(`report: ${join(CONFIG.logDir, 'latest-report.md')}`);
}

// -------------------------------------------------------------------- main

function main() {
  log(`=== memory sweep start (run ${RUN_ID})${DRY_RUN ? ' [DRY RUN]' : ''} ===`);
  log(`layers: ${Object.entries(LAYERS).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none'}`);

  const bp = preflightBilling();
  if (bp.length) {
    for (const p of bp) log(`BILLING PREFLIGHT FAILED: ${p}`);
    log('refusing to run. Subscription first: no API spend without an explicit ruling.');
    writeFileSync(join(CONFIG.logDir, 'latest-report.md'),
      `# Memory sweep did not run\n\nSubscription path unverified, and this job never falls back to metered spend.\n\n` +
      bp.map((p) => `- ${p}`).join('\n') + '\n');
    return;
  }
  if (!existsSync(join(V, '.git'))) { log(`vault is not a git repo: ${V}. Refusing: git history is the undo mechanism.`); return; }

  const lock = join(CONFIG.logDir, 'run.lock');
  if (existsSync(lock)) {
    const age = Date.now() - Number(readFileSync(lock, 'utf8').trim() || 0);
    if (age < CONFIG.globalDeadlineMs) { log('another sweep holds the lock, exiting'); return; }
    log('stale lock, taking over');
  }
  writeFileSync(lock, String(Date.now()));

  const results = [];
  try {
    const wanted = ONLY ? new Set(ONLY.split(',')) : null;
    let projects = readdirSync(PM).filter((n) => existsSync(join(PM, n, 'MEMORY.md')))
      .filter((n) => !CONFIG.skipProjects.includes(n))
      .filter((n) => !wanted || wanted.has(n));

    // Rotate so a cost cap does not starve the same projects every run.
    if (projects.length > 1) {
      const hoursSinceEpoch = Math.floor(STARTED_AT.getTime() / 3600000);
      const off = hoursSinceEpoch % projects.length;
      projects = projects.slice(off).concat(projects.slice(0, off));
    }
    log(`projects: ${projects.join(', ')}`);

    const deadline = Date.now() + CONFIG.globalDeadlineMs;
    for (const p of projects) {
      if (Date.now() > deadline) { log('deadline reached, stopping'); results.push({ project: p, status: 'skipped-deadline', applied: [], rejected: [], skippedFiles: [] }); continue; }
      if (SPEND.total >= CONFIG.sweepCostCapUsd) { log(`cost cap $${CONFIG.sweepCostCapUsd} reached, stopping`); results.push({ project: p, status: 'skipped-cost-cap', applied: [], rejected: [], skippedFiles: [] }); continue; }
      try { results.push(sweepProject(p)); }
      catch (e) { log(`  UNCAUGHT ${p}: ${e.message}`); results.push({ project: p, status: 'crashed', error: e.message, applied: [], rejected: [], skippedFiles: [] }); }
    }
  } finally {
    try { rmSync(lock, { force: true }); } catch { /* best effort */ }
  }

  writeReport(results);
  log('=== memory sweep done ===');
}

// Only sweep when invoked as a script. Importing this module (the validator test
// does) must not start a live run. realpath on both sides so the symlinked vault
// paths and any nvm shim still resolve equal.
function invokedDirectly() {
  try {
    return process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return true; // never let a resolution failure silently disable the scheduled job
  }
}

if (invokedDirectly()) main();

// Exported for guards.test-style verification. Not part of the run path.
export { validateOp };
