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

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DECISION_LOG = join(homedir(), '.claude', 'logs', 'cheap-decisions.jsonl');

// Archetype → model. Mirrors career-ops TASK_ROUTING_LADDERS' cheap rungs; kept as
// a local copy on purpose so this CLI has no cross-repo import. Prices per Mtok
// in/out, verified against the live OpenRouter catalog 2026-07-19, re-check
// before trusting them, they move.
const LADDERS = {
  bulk_summarize:        ['openai/gpt-oss-120b', 'deepseek/deepseek-v4-flash'],       // $0.04/$0.17
  bulk_mechanical_edit:  ['qwen/qwen3-coder-30b-a3b-instruct', 'z-ai/glm-4.7-flash'], // $0.07/$0.27
  log_triage:            ['openai/gpt-oss-120b', 'deepseek/deepseek-v4-flash'],       // $0.04/$0.17
  boilerplate_generation:['qwen/qwen3-coder-30b-a3b-instruct', 'qwen/qwen3-coder'],   // $0.07/$0.27
  structured_extraction: ['openai/gpt-oss-120b', 'qwen/qwen3-coder-30b-a3b-instruct'],
  long_context:          ['deepseek/deepseek-v4-flash', 'z-ai/glm-4.7-flash'],        // 1M / 200k ctx
};
const DEFAULT_MODEL = 'openrouter/auto';

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
const model = args.model || ladder[0] || DEFAULT_MODEL;

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

const started = Date.now();
let res;
try {
  res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      'X-Title': 'stack-ops cheap',
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: body }],
      // ZERO-DATA-RETENTION IS MANDATORY on this path (ruled 2026-07-19). Auto can
      // land a prompt at ANY catalog provider under varying retention terms, so the
      // fix is at the mechanism, not the data. `data_collection: 'deny'` restricts
      // routing to providers that do not train on or retain prompts. A provider
      // that cannot honour it simply does not receive this traffic.
      provider: { data_collection: 'deny' },
    }),
  });
} catch (e) {
  console.error(`cheap: request failed, ${e.message}`);
  process.exit(5);
}

if (!res.ok) {
  console.error(`cheap: OpenRouter returned ${res.status} ${res.statusText}\n${(await res.text()).slice(0, 500)}`);
  process.exit(6);
}

const json = await res.json();
const text = json?.choices?.[0]?.message?.content ?? '';
process.stdout.write(text.endsWith('\n') ? text : text + '\n');

// The decision log is what turns "Auto misroutes" from an argument into a measured
// fact. Escalation-as-label: if Mitchell re-asks or redoes a task in the main loop,
// that row was under-routed.
logDecision({
  ts: new Date().toISOString(),
  outcome: 'ok',
  task: args.task || null,
  requested: model,
  served: json?.model ?? null,          // what Auto actually picked
  provider: json?.provider ?? null,
  usage: json?.usage ?? null,
  chars: body.length,
  files: args.files.length,
  ms: Date.now() - started,
});
