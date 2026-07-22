#!/usr/bin/env node
/**
 * cheap-batch.mjs: run the recurring bulk jobs on the cheap tier, unattended.
 *
 * WHY. The cheap tier was opt-in and opt-in failed: one routed task across the
 * decision log's entire lifetime. Interactive auto-routing depends on whoever is
 * driving remembering to reach for it, which is the same failure mode wearing a
 * different hat. Scheduled batches do not depend on anyone remembering.
 *
 * SHIPS DOUBLE-DISABLED, matching the convention career-ops uses for every
 * unattended job that spends money (LinkedIn auto-unsave, idea-action routine):
 *   1. Disabled=true in the plist, and
 *   2. the CHEAP_BATCH_ENABLED kill switch, which --scheduled honours.
 * A manual run is DRY by default and calls nothing. Arm only after a live
 * --apply verification.
 *
 * COST IS BOUNDED THREE WAYS: a per-run job cap, a per-job byte cap on input,
 * and the fact that every job routes through the `cheap` CLI, so the privacy
 * gate and the ZDR provider filter apply exactly as they do interactively. This
 * script never calls a model directly. It shells out, so there is exactly one
 * routing path in the system and one decision log.
 *
 * Usage:
 *   node scripts/cheap-batch.mjs                 # DRY: show the plan, call nothing
 *   node scripts/cheap-batch.mjs --apply         # run it
 *   node scripts/cheap-batch.mjs --apply --scheduled   # + honour the kill switch
 *   node scripts/cheap-batch.mjs --job log_triage      # one job only
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const HOME = homedir();
const LEDGER = process.env.CHEAP_BATCH_LEDGER || join(HOME, '.claude', 'logs', 'cheap-batch-ledger.jsonl');
const OUT_DIR = process.env.CHEAP_BATCH_OUT || join(HOME, '.claude', 'logs', 'cheap-batch-output');
const MAX_JOBS = Number(process.env.CHEAP_BATCH_MAX_PER_RUN) || 5;
const MAX_BYTES = Number(process.env.CHEAP_BATCH_MAX_INPUT_BYTES) || 400_000;

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const scheduled = args.includes('--scheduled');

// `args[args.indexOf(f) + 1]` is a trap: a missing flag gives indexOf === -1, and
// -1 + 1 === 0, so the value silently becomes args[0]. Here that was an ACTIVE
// bug, not a latent one: `--apply` alone resolved onlyJob to "--apply" and the
// run died with "no job named --apply", which is exactly what the launchd
// invocation (`--apply --scheduled`) would have done every night. The live-fire
// test missed it because the kill switch returns before job selection is reached.
// Guard the index, matching the arg() helper in publish-report-to-notebooklm.mjs.
// A trailing `--job` with no value returned undefined, indistinguishable from the
// flag being absent, so `--apply --job` silently ran the FULL job set instead of
// the one the caller was trying to name. Under --apply that executes unintended
// work. Absent flag still returns undefined; a flag with no usable value is now a
// hard exit.
function flagValue(flag) {
  const i = args.indexOf(flag);
  if (i === -1) return undefined;
  const value = args[i + 1];
  if (!value || value.startsWith('--')) {
    console.error(`cheap-batch: ${flag} requires a value.`);
    process.exit(2);
  }
  return value;
}
const onlyJob = flagValue('--job');

// Kill switch, checked ONLY under --scheduled so a deliberate manual run is
// never silently a no-op. Must be exactly 'true'; anything else means off.
if (scheduled && process.env.CHEAP_BATCH_ENABLED !== 'true') {
  console.log('cheap-batch: CHEAP_BATCH_ENABLED is not "true"; scheduled run is a no-op by design.');
  process.exit(0);
}

/**
 * The job table. Each job names a task archetype (which picks the ladder), a
 * source of input, and an instruction.
 *
 * `collect` returns { text, label } or null when there is nothing to do. Jobs
 * MUST be individually skippable: a missing input is a normal condition on a
 * machine where not every pipeline ran, not an error worth failing the run over.
 */
const JOBS = [
  {
    name: 'log_triage',
    task: 'log_triage',
    instruction: 'Group these log lines by root cause. For each group give the cause, the count, and one representative line. Ignore noise that repeats identically.',
    collect() {
      const candidates = [
        join(HOME, 'Library', 'Logs', 'career-ops'),
        join(HOME, '.claude', 'logs'),
      ].filter(existsSync);
      // The cap is on the TOTAL, not per file. An earlier version capped each
      // file and then concatenated, which collected 1.7 MB across many small
      // logs: the cap was real and enforced and bought nothing, because nothing
      // checked the sum. Caught by the dry run before it could cost anything,
      // which is the entire reason this script is DRY by default.
      let text = '';
      for (const dir of candidates) {
        for (const f of safeList(dir).filter(f => f.endsWith('.log') || f.endsWith('.err'))) {
          if (Buffer.byteLength(text) >= MAX_BYTES) break;
          const p = join(dir, f);
          try {
            if (statSync(p).size > MAX_BYTES) continue;
            const room = MAX_BYTES - Buffer.byteLength(text);
            // Tail, not head: the recent end of a log is where the failures are.
            text += `\n===== ${f} =====\n` + readFileSync(p, 'utf8').slice(-Math.min(80_000, room));
          } catch { /* unreadable log is not a failure */ }
        }
      }
      if (Buffer.byteLength(text) > MAX_BYTES) text = text.slice(-MAX_BYTES);
      return text.trim() ? { text, label: 'logs' } : null;
    },
  },
  {
    name: 'routing_digest',
    task: 'structured_extraction',
    instruction: 'From this routing decision log, produce: (1) the count of routed vs refused vs escalated, (2) the single most common refusal reason, (3) any task archetype that was never used. Be terse.',
    collect() {
      const p = process.env.CHEAP_DECISION_LOG || join(HOME, '.claude', 'logs', 'cheap-decisions.jsonl');
      if (!existsSync(p)) return null;
      // PROJECT TO SAFE FIELDS. Sending the raw log self-refuses, and correctly
      // so: refusal rows quote the gate's own patterns verbatim, including the
      // private-path regexes, so the log is full of strings the gate is built to
      // catch. Verified live 2026-07-22 (exit 3, private-path). The digest only
      // needs outcome, task, model and signal NAME, never the matched detail, so
      // project rather than weaken the gate. A job that needed the raw log would
      // be a job that should not run on the cheap tier at all.
      const rows = readFileSync(p, 'utf8').trim().split('\n').map(l => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean).map(r => ({
        ts: r.ts,
        outcome: r.outcome,
        task: r.task,
        served: r.served,
        signals: (r.reasons || []).map(x => x.signal),   // NAME only, never .detail
        reason: r.reason,
        cost: r.usage?.cost,
        ms: r.ms,
      }));
      const text = rows.map(r => JSON.stringify(r)).join('\n').slice(-MAX_BYTES);
      return text.trim() ? { text, label: 'decisions (projected)' } : null;
    },
  },
];

function safeList(dir) {
  try { return execFileSync('/bin/ls', [dir], { encoding: 'utf8' }).trim().split('\n').filter(Boolean); }
  catch { return []; }
}

function log(rec) {
  try { mkdirSync(dirname(LEDGER), { recursive: true }); appendFileSync(LEDGER, JSON.stringify(rec) + '\n'); }
  catch { /* the ledger must never break the run */ }
}

const selected = (onlyJob ? JOBS.filter(j => j.name === onlyJob) : JOBS).slice(0, MAX_JOBS);
if (!selected.length) {
  console.error(`cheap-batch: no job named "${onlyJob}". Known: ${JOBS.map(j => j.name).join(', ')}`);
  process.exit(2);
}

console.log(`cheap-batch: ${apply ? 'APPLY' : 'DRY RUN (calls nothing)'} · ${selected.length} job(s) · cap ${MAX_JOBS}/run\n`);

let ran = 0, skipped = 0, failed = 0;
for (const job of selected) {
  const input = job.collect();
  if (!input) {
    console.log(`  SKIP  ${job.name.padEnd(18)} no input available`);
    skipped++;
    continue;
  }
  const bytes = Buffer.byteLength(input.text);
  if (!apply) {
    console.log(`  PLAN  ${job.name.padEnd(18)} task=${job.task.padEnd(22)} ${bytes.toLocaleString()} bytes from ${input.label}`);
    continue;
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const started = Date.now();
  // Shell out to the SAME `cheap` CLI an interactive call uses. That is the
  // point: one routing path, one privacy gate, one decision log. A batch job
  // that called OpenRouter directly would bypass every control at once.
  const res = spawnSync(join(HOME, '.claude', 'bin', 'cheap'),
    ['--task', job.task, job.instruction],
    { input: input.text, encoding: 'utf8', timeout: 300_000 });

  const ms = Date.now() - started;
  if (res.status === 0 && res.stdout?.trim()) {
    const out = join(OUT_DIR, `${job.name}-${new Date().toISOString().slice(0, 10)}.md`);
    writeFileSync(out, res.stdout);
    console.log(`  OK    ${job.name.padEnd(18)} ${ms}ms -> ${out}`);
    log({ ts: new Date().toISOString(), job: job.name, task: job.task, outcome: 'ok', bytes, ms, out });
    ran++;
  } else {
    // Exit 3 is a privacy-gate refusal and is a CORRECT outcome, not a failure:
    // it means the batch tried to send something it should not have, and the
    // gate stopped it. Record it distinctly so it never reads as breakage.
    const kind = res.status === 3 ? 'gate_refused' : 'failed';
    console.log(`  ${kind === 'gate_refused' ? 'GATE ' : 'FAIL '} ${job.name.padEnd(18)} exit=${res.status} ${String(res.stderr || '').split('\n')[0]}`);
    log({ ts: new Date().toISOString(), job: job.name, task: job.task, outcome: kind, exit: res.status, bytes, ms });
    if (kind === 'failed') failed++; else skipped++;
  }
}

console.log(`\ncheap-batch: ${ran} ran · ${skipped} skipped/gated · ${failed} failed`);
if (!apply) console.log('Nothing was called. Re-run with --apply to execute.');
// A failed job must not fail the whole scheduled run; the ledger carries the detail.
process.exit(0);
