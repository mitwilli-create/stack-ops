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
// The gate is imported, not reimplemented. Re-typing its patterns here would
// invent bugs that do not exist and would drift the moment the gate changes.
import { classify, buildConfig, loadPrivateConfig, extractPathLikeTokens, ROUTE, SIGNAL } from '../src/router/privacy-gate.mjs';

const GATE_CFG = buildConfig(await loadPrivateConfig());

/**
 * Replace private-path TOKENS with a placeholder, leaving the surrounding log
 * line intact. Only tokens that actually match a private-path pattern are
 * touched, so ordinary paths in a stack trace survive and stay useful for triage.
 *
 * This handles path REFERENCES only. A file containing a credential VALUE is
 * excluded upstream and never reaches this function; redacting a secret and
 * sending the remainder is not a thing this script does.
 */
function redactPathTokens(text, cfg) {
  let out = text;
  for (const tok of new Set(extractPathLikeTokens(text))) {
    const isPrivate = cfg.privatePathPatterns.some(re => { re.lastIndex = 0; return re.test(tok); });
    if (!isPrivate) continue;
    // extractPathLikeTokens normalizes (~ -> /home, \ -> /), so match on the
    // recognizable tail rather than the normalized form, which may not appear
    // literally in the source text.
    const tail = tok.split('/').filter(Boolean).slice(-2).join('/');
    if (!tail) continue;
    out = out.split(tail).join('<redacted-path>');
  }
  return out;
}

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
      //
      // PER-FILE ADMISSION (2026-07-22). Concatenating first meant ONE poisoned
      // file gated the whole job, and measured, 41 of 45 local logs tripped the
      // gate, so log_triage could never route at all. Each file is now judged on
      // its own and the survivors are joined.
      //
      // Two DIFFERENT dispositions, and the difference is the whole design:
      //
      //   PATH REFERENCES are redacted. Nearly every hit was a line like
      //   "loaded /Users/x/.secrets/api-keys.env:35", which names WHERE a key
      //   lives and contains no key. Replacing the token with <path> is a local,
      //   deterministic DLP pass and loses nothing a log triage needs.
      //
      //   CREDENTIAL / PII / EMPLOYER hits DISQUALIFY the file outright. It is
      //   never redacted and re-sent. Three local logs really do contain live
      //   secret VALUES, and stripping a secret so the remainder can be sent is
      //   the sanitization paradox: you cannot ask a third party to handle
      //   material it was prohibited from receiving, and a near-miss redaction
      //   leaks. Those files stay off the cheap path permanently.
      //
      // The gate is re-run on the REDACTED text and is still authoritative: if a
      // file passes here but the gate refuses the assembled body, the job
      // refuses. This adds a filter in front of the gate; it never bypasses it.
      const parts = [];
      let excludedSecret = 0, excludedOther = 0, redacted = 0, bytes = 0;
      // NEWEST FIRST. `ls` returns alphabetical order, so with a byte cap the job
      // always triaged the same alphabetical prefix and never reached the rest.
      // That made the admission logic look effective when it was really the cap
      // doing the filtering by luck: the logs that DO carry credential values sort
      // late and were never examined. Recency is also simply what triage wants.
      const files = candidates.flatMap(dir =>
        safeList(dir)
          .filter(f => f.endsWith('.log') || f.endsWith('.err'))
          .map(f => join(dir, f)))
        .map(p => { try { return { p, mtime: statSync(p).mtimeMs, size: statSync(p).size }; } catch { return null; } })
        .filter(Boolean)
        .sort((a, b) => b.mtime - a.mtime);

      for (const { p, size } of files) {
        {
          if (bytes >= MAX_BYTES) break;
          const f = p.split('/').pop();
          let raw;
          try {
            if (size > MAX_BYTES) continue;
            raw = readFileSync(p, 'utf8').slice(-80_000);   // tail: failures live at the end
          } catch { continue; }
          if (!raw.trim()) continue;

          const before = classify({ text: raw }, GATE_CFG);
          const signals = new Set(before.reasons.map(r => r.signal));
          if (signals.has(SIGNAL.SECRET) || signals.has(SIGNAL.PII) || signals.has(SIGNAL.EMPLOYER)) {
            excludedSecret++;
            continue;                                       // disqualified, never redacted
          }

          let body = raw;
          if (signals.has(SIGNAL.PRIVATE_PATH)) {
            body = redactPathTokens(raw, GATE_CFG);
            redacted++;
          }
          // Re-judge after redaction. A file that still trips anything is dropped
          // rather than argued with.
          if (classify({ text: body }, GATE_CFG).route !== ROUTE.AUTO) { excludedOther++; continue; }

          const room = MAX_BYTES - bytes;
          const chunk = `\n===== ${f} =====\n` + body.slice(0, room);
          parts.push(chunk);
          bytes += Buffer.byteLength(chunk);
        }
      }
      if (!parts.length) return null;
      console.log(`        (logs: ${parts.length} admitted, ${redacted} path-redacted, ` +
        `${excludedSecret} excluded for credential/PII/employer content, ${excludedOther} excluded post-redaction)`);
      return { text: parts.join('\n'), label: `logs (${parts.length} files)` };
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
  if (args.includes('--dump-body')) {
    // Verification aid: write exactly what WOULD be sent, so the assembled body
    // can be scanned independently before any run. Never used in normal operation.
    mkdirSync(OUT_DIR, { recursive: true });
    const dump = join(OUT_DIR, `DUMP-${job.name}.txt`);
    writeFileSync(dump, input.text);
    console.log(`  DUMP  ${job.name.padEnd(18)} -> ${dump}`);
    continue;
  }
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
