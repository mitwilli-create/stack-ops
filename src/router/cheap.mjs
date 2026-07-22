#!/usr/bin/env node
/**
 * cheap.mjs, dispatch BULK TOIL to the cheap tier, with the privacy gate in front.
 *
 * WHY THIS IS A CLI AND NOT A GATEWAY (ruled 2026-07-19, see
 * stack-ops/private/decisions/D6-claude-code-auth-and-routing.md):
 *
 * Claude Code's main loop CANNOT be routed. Per Anthropic's own gateway docs, an
 * active gateway credential replaces the subscription login and bills per token,
 * and routing Claude Code to non-Claude models through a gateway is explicitly
 * unsupported. Cursor's own agent is off-limits for the same reason: it runs on a
 * flat subscription, so rerouting it converts flat spend into metered spend.
 *
 * So cheap routing attaches to DELEGATED work instead. The main loop stays on the
 * subscription and shells out to this command for grunt work. Nothing here touches
 * Claude Code's authentication, so there is no billing inversion and no ToS
 * exposure from subscription OAuth reaching a third party.
 *
 * SCOPING CONDITION, this earns its keep on BULK work only. Summarizing forty
 * files, triaging a large log, mechanical edits across a tree: the cheap model does
 * heavy generation and the saving is real. On a small one-off task the
 * orchestration overhead exceeds the saving, and you should just do it inline.
 * The CLI warns when input looks too small to be worth the round trip.
 *
 * Usage:
 *   cheap "summarize each of these" --files src/*.mjs
 *   cat big.log | cheap --task log_triage "find the repeated stack traces"
 *   cheap --task bulk_summarize --files notes/*.md "one-line takeaway each"
 *   cheap --dry-run "..."        # show the routing decision, call nothing
 */
import { readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { classifyAsync } from './privacy-gate.mjs';
import { ROUTE } from './privacy-gate.mjs';

const OPENROUTER_URL = process.env.CHEAP_OPENROUTER_URL || 'https://openrouter.ai/api/v1/chat/completions';
const DECISION_LOG = process.env.CHEAP_DECISION_LOG || join(homedir(), '.claude', 'logs', 'cheap-decisions.jsonl');

// Bounded timeout so a stuck upstream can NEVER hang the caller (2026-07-20). A
// slow openrouter/auto pick was observed hanging a trivial request past 120s with
// no bound, which is a large part of why no real traffic trusts this path. The
// default is generous for bulk generation; env-overridable for tests and tuning.
const TIMEOUT_MS = Number(process.env.CHEAP_TIMEOUT_MS) || 180000;

// Archetype → model. Mirrors career-ops TASK_ROUTING_LADDERS' cheap rungs; kept as
// a local copy on purpose so this CLI has no cross-repo import.
//
// PRICES ARE PER MODEL, NOT PER LADDER. Until 2026-07-22 each ladder carried one
// price pair that described only its FIRST rung and was silently attributed to the
// fallback too. That understated `glm-4.7-flash` output by 48% and `deepseek-v4-flash`
// input by 2.5x, on the exact rungs that carry the largest payloads. Any cost model
// built from the old annotations was wrong on every step-down. Annotate per model so
// a fallback's real price is visible at the point of fallback.
//
// Per Mtok in/out, verified against the live OpenRouter catalog API 2026-07-22.
// They move: re-check with `curl -s https://openrouter.ai/api/v1/models` before
// trusting these for any spend estimate.
//
//   openai/gpt-oss-120b                    $0.037 / $0.170
//   deepseek/deepseek-v4-flash             $0.098 / $0.196    1,048,576 ctx
//   qwen/qwen3-coder-30b-a3b-instruct      $0.070 / $0.270
//   qwen/qwen3-coder                       $0.070 / $0.270
//   z-ai/glm-4.7-flash                     $0.061 / $0.400    <- dearest output on the ladder
//
// All five rungs verified ZDR-eligible 2026-07-22 (see the provider block below).
// A new rung MUST be checked against `?zdr=true` before it lands here, or the
// privacy gate will refuse it at call time.
const LADDERS = {
  bulk_summarize:        ['openai/gpt-oss-120b', 'deepseek/deepseek-v4-flash'],
  bulk_mechanical_edit:  ['qwen/qwen3-coder-30b-a3b-instruct', 'z-ai/glm-4.7-flash'],
  log_triage:            ['openai/gpt-oss-120b', 'deepseek/deepseek-v4-flash'],
  boilerplate_generation:['qwen/qwen3-coder-30b-a3b-instruct', 'qwen/qwen3-coder'],
  structured_extraction: ['openai/gpt-oss-120b', 'qwen/qwen3-coder-30b-a3b-instruct'],
  long_context:          ['deepseek/deepseek-v4-flash', 'z-ai/glm-4.7-flash'],
};

// Below this, orchestration overhead beats the saving. Advisory, not a hard stop.
const BULK_THRESHOLD_CHARS = 2000;

function parseArgs(argv) {
  const out = { files: [], dryRun: false, prompt: '' };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--task') out.task = argv[++i];
    else if (a === '--model') out.model = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--files') { while (argv[i + 1] && !argv[i + 1].startsWith('--')) out.files.push(argv[++i]); }
    else rest.push(a);
  }
  out.prompt = rest.join(' ').trim();
  return out;
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  let d = '';
  for await (const c of process.stdin) d += c;
  return d;
}

function logDecision(record) {
  try {
    mkdirSync(dirname(DECISION_LOG), { recursive: true });
    appendFileSync(DECISION_LOG, JSON.stringify(record) + '\n');
  } catch { /* logging must never break the call */ }
}

const args = parseArgs(process.argv.slice(2));
const stdin = await readStdin();

// Build the full body ONCE and scan all of it. The scanner is full-content by
// contract, file bodies included, never just the instruction.
const fileBlobs = args.files.map(f => {
  try { return `\n\n===== ${f} =====\n` + readFileSync(f, 'utf8'); }
  catch (e) { return `\n\n===== ${f} (unreadable: ${e.code}) =====\n`; }
});
const body = [args.prompt, stdin, ...fileBlobs].filter(Boolean).join('\n');

if (!body.trim()) {
  console.error('cheap: nothing to do, pass a prompt, pipe stdin, or use --files');
  process.exit(2);
}

const decision = await classifyAsync({ text: body, paths: args.files });

// A sensitive request is NOT quietly rerouted to Anthropic here. This command's
// entire purpose is the cheap path; if the gate says no, the honest outcome is to
// refuse and let the main loop (already on the subscription, already trusted) do
// the work. Silently calling a frontier model would hide the cost, not save it.
if (decision.route !== ROUTE.AUTO) {
  const why = decision.reasons.map(r => `${r.signal}: ${r.detail}`).join(' · ');
  console.error(`cheap: REFUSED, the privacy gate flagged this request.\n  ${why}\n` +
    `  Do this one in Claude Code instead (it is already on the trusted path).`);
  logDecision({ ts: new Date().toISOString(), outcome: 'refused', task: args.task || null, reasons: decision.reasons, chars: body.length });
  process.exit(3);
}

const ladder = LADDERS[args.task] || [];

// An untagged call (no --task and no --model) used to fall through to a catch-all
// pick, which OpenRouter Auto could land on a FRONTIER model. That silently turns a
// "cheap" call into a premium one, the exact cost-hiding this command exists to
// avoid. So refuse, same posture as the privacy-gate refusal above: no routing
// target, do it inline (already on the trusted path) or name one explicitly.
if (!args.model && ladder.length === 0) {
  const tasks = Object.keys(LADDERS).join(', ');
  console.error(`cheap: REFUSED, no routing target. Pass --task <one of: ${tasks}> or an explicit --model,\n` +
    `  or do this one inline in Claude Code (it is already on the trusted path).`);
  logDecision({ ts: new Date().toISOString(), outcome: 'refused', reason: 'no-task-or-model', task: args.task || null, chars: body.length });
  process.exit(8);
}

const model = args.model || ladder[0];

if (body.length < BULK_THRESHOLD_CHARS && !args.dryRun) {
  console.error(`cheap: note, input is ${body.length} chars, under the ${BULK_THRESHOLD_CHARS} bulk threshold. ` +
    `This tier pays off on bulk work; a task this size is usually cheaper done inline.`);
}

if (args.dryRun) {
  console.log(JSON.stringify({ route: decision.route, task: args.task || null, model, ladder, chars: body.length, files: args.files.length }, null, 2));
  process.exit(0);
}

const key = process.env.OPENROUTER_API_KEY;
if (!key) {
  console.error('cheap: OPENROUTER_API_KEY is not set in this environment.');
  process.exit(4);
}

// Try the task's ladder rung by rung. Before this the second rung was dead code: a
// single `ladder[0]` with no fallback meant one bad upstream (HTTP error, timeout,
// or empty completion) failed the whole call instead of stepping down to the next
// cheap model. An explicit --model opts out of the ladder and stands alone.
const candidates = args.model ? [args.model] : ladder;
let lastExit = 5;

for (let i = 0; i < candidates.length; i++) {
  const rungModel = candidates[i];
  const started = Date.now();
  let res;
  try {
    res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
        'X-Title': 'stack-ops cheap',
      },
      body: JSON.stringify({
        model: rungModel,
        messages: [{ role: 'user', content: body }],
        // ZERO-DATA-RETENTION IS MANDATORY on this path (ruled 2026-07-19, hardened
        // 2026-07-22). Auto can land a prompt at ANY catalog provider under varying
        // retention terms, so the fix is at the mechanism, not the data. A provider
        // that cannot honour these terms simply does not receive this traffic.
        //
        // SEND BOTH FLAGS. OpenRouter documents these as two SEPARATE provider-routing
        // controls, and neither is documented as subsuming the other:
        //   data_collection: 'deny'  excludes providers that may store or train on prompts
        //   zdr: true                restricts routing to zero-data-retention endpoints
        // Non-retention and zero-retention are different guarantees: a provider can
        // decline to train on a prompt while still holding it transiently for abuse
        // monitoring. Sending only `data_collection` asserted a stronger property than
        // the flag actually bought. The ZDR-filtered catalog is strictly smaller (222 of
        // 342 models on 2026-07-22), which is what makes `zdr` the tighter control.
        //
        // Verified 2026-07-22: all five ladder rungs pass `?zdr=true`, so this narrows
        // nothing in practice. Re-check after any rung change.
        // https://openrouter.ai/docs/features/provider-routing
        //
        // `sort: 'throughput'` added 2026-07-22 after measuring a 12x latency
        // spread WITHIN a single model, by provider alone: gpt-oss-120b served an
        // identical 15.6 KB payload in 12.8s on DekaLLM and 1.0s on SambaNova.
        // Pure speed win with no privacy tradeoff, because it only REORDERS the
        // providers that already survived the two retention filters above.
        provider: { data_collection: 'deny', zdr: true, sort: 'throughput' },
      }),
    });
  } catch (e) {
    // AbortSignal.timeout fires a TimeoutError; a manual abort fires AbortError.
    const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    console.error(timedOut
      ? `cheap: ${rungModel} did not respond within ${TIMEOUT_MS}ms, aborted.`
      : `cheap: ${rungModel} request failed, ${e.message}`);
    // Log every attempt so a step-down is VISIBLE in the decision log, not silent.
    logDecision({ ts: new Date().toISOString(), outcome: timedOut ? 'timeout' : 'error',
      task: args.task || null, requested: rungModel, rung: i, detail: e?.message ?? String(e), chars: body.length, ms: Date.now() - started });
    lastExit = timedOut ? 7 : 5;
    continue;
  }

  if (!res.ok) {
    // Reading the error body can itself throw (dropped connection mid-body); a
    // failure here must not escape the loop, so swallow it and keep the status.
    const errText = await res.text().catch(() => '').then(t => t.slice(0, 500));
    console.error(`cheap: ${rungModel} returned ${res.status} ${res.statusText}\n${errText}`);
    logDecision({ ts: new Date().toISOString(), outcome: 'http_error', task: args.task || null,
      requested: rungModel, rung: i, status: res.status, chars: body.length, ms: Date.now() - started });
    lastExit = 6;
    continue;
  }

  // res.json() runs outside the fetch try/catch, so a 200 with a truncated or
  // non-JSON body would otherwise reject and crash the whole call instead of
  // stepping down. Treat an unparseable body as a soft failure and try the next rung.
  let json;
  try {
    json = await res.json();
  } catch (e) {
    console.error(`cheap: ${rungModel} returned an unparseable body, ${e.message}`);
    logDecision({ ts: new Date().toISOString(), outcome: 'error', task: args.task || null,
      requested: rungModel, rung: i, detail: e?.message ?? String(e), chars: body.length, ms: Date.now() - started });
    lastExit = 5;
    continue;
  }
  const text = json?.choices?.[0]?.message?.content ?? '';
  if (!text.trim()) {
    // An empty completion is a soft failure: the rung answered but returned nothing
    // usable, so step down rather than emit a blank as if it were the answer.
    console.error(`cheap: ${rungModel} returned an empty completion.`);
    logDecision({ ts: new Date().toISOString(), outcome: 'empty', task: args.task || null,
      requested: rungModel, rung: i, served: json?.model ?? null, chars: body.length, ms: Date.now() - started });
    lastExit = 5;
    continue;
  }

  process.stdout.write(text.endsWith('\n') ? text : text + '\n');

  // The decision log is what turns "Auto misroutes" from an argument into a measured
  // fact. Escalation-as-label: if Mitchell re-asks or redoes a task in the main loop,
  // that row was under-routed.
  logDecision({
    ts: new Date().toISOString(),
    outcome: 'ok',
    task: args.task || null,
    requested: rungModel,
    rung: i,
    served: json?.model ?? null,          // what the provider actually served
    provider: json?.provider ?? null,
    usage: json?.usage ?? null,
    chars: body.length,
    files: args.files.length,
    ms: Date.now() - started,
  });
  process.exit(0);
}

// Every cheap rung failed. RULED 2026-07-22: escalate to a frontier model rather
// than refusing, because a stalled overnight batch costs Mitchell more than the
// escalation does.
//
// This REVERSES the original posture, and the original reasoning was not wrong:
// a silent frontier call hides cost, which is the exact failure this command
// exists to prevent. So the ruling is conditional on the escalation being
// IMPOSSIBLE TO MISS. That is what the banner and the distinct `outcome:
// "escalated"` row below are for, and why the row carries `after_rungs` naming
// every cheap model that failed first. Do not quiet either one.
//
// SCOPE: this escalates only on RUNG FAILURE (upstream error, timeout, empty or
// unparseable completion). It never escalates a PRIVACY-GATE refusal. A gate
// refusal is a security decision about where data may go, and auto-escalating it
// would route flagged content onward instead of stopping, which is the one thing
// the gate exists to prevent. That path still exits 3 above and always will.
const ESCALATION_MODEL = process.env.CHEAP_ESCALATION_MODEL || 'anthropic/claude-sonnet-5';

if (process.env.CHEAP_NO_ESCALATE === '1') {
  console.error(`cheap: all ${candidates.length} model(s) for this task failed, and escalation is disabled. ` +
    `Do this one inline in Claude Code (it is already on the trusted path).`);
  process.exit(lastExit);
}

console.error(`\n${'='.repeat(72)}\n` +
  `⚠️  ESCALATING TO A FRONTIER MODEL. This call is NOT cheap.\n` +
  `    All ${candidates.length} cheap rung(s) failed: ${candidates.join(', ')}\n` +
  `    Now calling: ${ESCALATION_MODEL}\n` +
  `    Suppress with CHEAP_NO_ESCALATE=1 to refuse instead.\n` +
  `${'='.repeat(72)}\n`);

const escStarted = Date.now();
try {
  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      'X-Title': 'stack-ops cheap (escalated)',
    },
    // Same retention terms as the cheap path. Escalating changes the price tier,
    // never the privacy posture.
    body: JSON.stringify({
      model: ESCALATION_MODEL,
      messages: [{ role: 'user', content: body }],
      provider: { data_collection: 'deny', zdr: true },
    }),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const json = await res.json();
  const text = json?.choices?.[0]?.message?.content ?? '';
  if (!text.trim()) throw new Error('empty completion');

  process.stdout.write(text.endsWith('\n') ? text : text + '\n');
  logDecision({
    ts: new Date().toISOString(),
    outcome: 'escalated',                 // distinct from 'ok' ON PURPOSE, so a
    task: args.task || null,              // spend audit can count these alone
    requested: ESCALATION_MODEL,
    served: json?.model ?? null,
    provider: json?.provider ?? null,
    usage: json?.usage ?? null,
    after_rungs: candidates,              // which cheap models failed first
    chars: body.length,
    files: args.files.length,
    ms: Date.now() - escStarted,
  });
  console.error(`cheap: escalation succeeded on ${ESCALATION_MODEL}, logged as outcome=escalated.`);
  process.exit(0);
} catch (e) {
  console.error(`cheap: escalation to ${ESCALATION_MODEL} also failed, ${e.message}. ` +
    `Do this one inline in Claude Code (it is already on the trusted path).`);
  logDecision({ ts: new Date().toISOString(), outcome: 'escalation_failed', task: args.task || null,
    requested: ESCALATION_MODEL, after_rungs: candidates, detail: e?.message ?? String(e),
    chars: body.length, ms: Date.now() - escStarted });
  process.exit(lastExit);
}
