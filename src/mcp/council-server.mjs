#!/usr/bin/env node
/**
 * council-server.mjs, narrow MCP server wrapping the multi-model council engine.
 *
 * Exposes two concerns so any agent (Claude Code, Codex, Gemini CLI, Grok, Kimi)
 * can reach the council engine without importing it:
 *
 *   ROUTING POLICY (read-only, no spend):
 *     - route_task(taskType)  → the provider:model lineup the router picks
 *     - route_media(taskType) → the media routing policy entry (tool + key NAME)
 *     - list_council()        → the research-council debate lineups + dispatchable ids
 *
 *   EXECUTION (spends real money - gated, capped, dry-runnable):
 *     - run_council(question, lineup?)      → fan the question out to a lineup
 *     - run_researcher(question, lineup?)   → research-framed fan-out for synthesis
 *     - run_dealbreaker(report, lineup?)    → adjudicate a research report's claims
 *
 * The execution tools REUSE the engine's callCouncil(); they never reimplement it.
 * Every execution call is gated three ways:
 *   1. COUNCIL_DRY_RUN (any truthy value) → echo the planned lineup + cost estimate,
 *      dispatch nothing, spend nothing.
 *   2. Hard per-call cap COUNCIL_MAX_CALL_USD (default $5) → refuse if the pre-flight
 *      estimate exceeds it.
 *   3. MONTHLY_BUDGET_USD → refuse if a single call's estimate alone exceeds it.
 * The engine's own per-vendor monthly cap (checkVendorCap) also stays in force -
 * these tools never pass opts.vendorCapsDisabled.
 *
 * Public code carries NO private path: the engine location comes from
 * COUNCIL_ENGINE_PATH (env) or the gitignored private/mcp-config.mjs, the same
 * public-code / private-config split the router uses.
 *
 * Run:  COUNCIL_ENGINE_PATH=/abs/path/to/career-ops/lib/council.mjs \
 *         node src/mcp/council-server.mjs
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

async function resolveEnginePath() {
  if (process.env.COUNCIL_ENGINE_PATH) return process.env.COUNCIL_ENGINE_PATH;
  try {
    const cfg = await import('../../private/mcp-config.mjs');
    return (cfg.default || cfg).councilEnginePath || null;
  } catch {
    return null;
  }
}

let enginePromise = null;
async function getEngine() {
  if (!enginePromise) {
    enginePromise = (async () => {
      const path = await resolveEnginePath();
      if (!path) {
        throw new Error('council engine not configured, set COUNCIL_ENGINE_PATH or private/mcp-config.mjs { councilEnginePath }');
      }
      return import(path);
    })();
  }
  return enginePromise;
}

const ok = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });
const fail = (msg) => ({ content: [{ type: 'text', text: `error: ${msg}` }], isError: true });

// ─── Execution gating helpers (exported for $0 unit tests) ──────────────────

/** COUNCIL_DRY_RUN truthy? Any value except unset/empty/0/false/no. */
export function isDryRun(env = process.env) {
  const v = String(env.COUNCIL_DRY_RUN ?? '').trim().toLowerCase();
  return v !== '' && v !== '0' && v !== 'false' && v !== 'no';
}

/** Hard per-call spend cap in USD (default $5). */
export function perCallCapUsd(env = process.env) {
  const n = Number(env.COUNCIL_MAX_CALL_USD);
  return Number.isFinite(n) && n > 0 ? n : 5;
}

/** Optional monthly budget ceiling in USD, or null when unset. */
export function monthlyBudgetUsd(env = process.env) {
  const n = Number(env.MONTHLY_BUDGET_USD);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Resolve a caller-supplied `lineup` to a concrete array of provider:model ids.
 *   - array (non-empty)              → used verbatim
 *   - named lineup key in engine     → RESEARCH_COUNCIL_LINEUPS[key]
 *   - any other non-empty string     → treated as a single model id [string]
 *   - absent/empty                   → engine DEFAULT_LINEUP (cheapest)
 */
export function resolveLineup(eng, lineup) {
  if (Array.isArray(lineup) && lineup.length) return lineup;
  if (typeof lineup === 'string' && lineup.trim()) {
    const key = lineup.trim();
    const named = (eng.RESEARCH_COUNCIL_LINEUPS || {})[key];
    if (named && named.length) return named;
    return [key];
  }
  return eng.DEFAULT_LINEUP || [];
}

/**
 * Conservative pre-flight cost estimate for a lineup + prompt. Assumes each model
 * reads the prompt (plus a fixed system-prompt overhead) and writes a fixed
 * completion budget. Intentionally OVER-estimates so the cap fails safe.
 */
export function estimateLineupCostUsd(eng, models, prompt, env = process.env) {
  const inTok = Math.ceil((prompt?.length || 0) / 4) + 500; // prompt + system overhead
  const outTok = Number(env.COUNCIL_EST_OUTPUT_TOKENS) || 2000; // assumed completion size
  const perModelTokens = inTok + outTok;
  const est = (models || []).reduce((sum, m) => sum + (eng.estimateCostUsd?.(m, perModelTokens) || 0), 0);
  return Math.round(est * 100000) / 100000;
}

/**
 * The one execution path all three tools share. Reuses eng.callCouncil().
 * `engine` may be injected (tests); otherwise resolved via getEngine().
 * Returns an MCP tool result (ok/fail shape).
 */
export async function runEngineTool({ toolName, prompt, models, opts = {}, engine } = {}) {
  try {
    if (!prompt || !String(prompt).trim()) return fail(`${toolName}: a non-empty question/report is required`);
    const eng = engine || (await getEngine());
    const lineup = resolveLineup(eng, models);
    if (!lineup.length) return fail(`${toolName}: could not resolve a lineup (no models and no DEFAULT_LINEUP)`);
    const estMaxCostUsd = estimateLineupCostUsd(eng, lineup, prompt);
    const cap = perCallCapUsd();
    const budget = monthlyBudgetUsd();
    const base = {
      tool: toolName,
      lineup,
      promptChars: String(prompt).length,
      estMaxCostUsd,
      perCallCapUsd: cap,
      monthlyBudgetUsd: budget,
    };

    if (isDryRun()) {
      return ok({ ...base, dryRun: true, note: 'COUNCIL_DRY_RUN set - planned only, no models dispatched, no spend' });
    }
    if (estMaxCostUsd > cap) {
      return fail(`${toolName}: per-call cap exceeded - est $${estMaxCostUsd.toFixed(4)} > COUNCIL_MAX_CALL_USD $${cap.toFixed(2)} (raise it to override, or set COUNCIL_DRY_RUN=1 to plan)`);
    }
    if (budget != null && estMaxCostUsd > budget) {
      return fail(`${toolName}: single-call estimate $${estMaxCostUsd.toFixed(4)} exceeds MONTHLY_BUDGET_USD $${budget.toFixed(2)}`);
    }

    const res = await eng.callCouncil({ prompt, models: lineup, opts });
    return ok({
      ...base,
      dryRun: false,
      totalMs: res?.totalMs,
      missingKeys: res?.missingKeys ?? [],
      results: (res?.results ?? []).map((r) => ({
        model: r.model,
        modelUsed: r.modelUsed,
        error: r.error ?? null,
        tokens: r.tokens,
        costUsd: r.costUsd,
        ms: r.ms,
        content: r.content,
      })),
    });
  } catch (e) {
    return fail(String(e?.message || e));
  }
}

// Research framing - makes run_researcher demand current, cited, synthesized
// output rather than a bare fan-out. Applied as opts.systemPrompt.
const RESEARCHER_SYSTEM_PROMPT =
  'You are a rigorous research analyst. Answer the question with current, verifiable facts. ' +
  'Cite sources inline where a claim is non-obvious. Separate what is well-supported from what is ' +
  'uncertain, and end with a short synthesized bottom line. Do not speculate without labeling it.';

/** Build the dealbreaker adjudication prompt from a report body. */
export function buildDealbreakerPrompt(reportText) {
  return (
    'You are the dealbreaker: a final reviewer of a research report. For EACH substantive claim, ' +
    'classify it as verified (multiple independent supports), corroborated (one support), ' +
    'unsupported (asserted with no support), or contradicted (evidence against). Cut unsupported and ' +
    'contradicted claims. Return (1) a cleaned report keeping only claims that survive, and (2) an audit ' +
    'list naming every claim you cut and why. Report under review:\n\n' + reportText
  );
}

/** Resolve run_dealbreaker's `report` arg: a small existing file path is read; anything else is text. */
export function loadReportText(report) {
  const s = String(report ?? '');
  if (s && !s.includes('\n') && s.length < 1024 && existsSync(s)) {
    try { return readFileSync(s, 'utf8'); } catch { return s; }
  }
  return s;
}

const server = new McpServer({ name: 'council', version: '0.2.0' });

server.registerTool(
  'route_task',
  {
    title: 'Route a task to its best model',
    description: 'Given a task archetype (e.g. code_refactor_multifile, structured_extraction, strategic_reasoning, long_form_research), return the provider:model lineup the task router picks. Read-only, no spend.',
    inputSchema: { taskType: z.string().describe('the task archetype key') },
  },
  async ({ taskType }) => {
    try {
      const eng = await getEngine();
      const lineup = eng.routeByArchetype(taskType);
      const known = Object.keys(eng.TASK_ROUTER_MATRIX || eng.TASK_ROUTING_MATRIX || {});
      return ok({ taskType, lineup, matched: known.includes(taskType), knownArchetypes: known });
    } catch (e) { return fail(String(e.message || e)); }
  },
);

server.registerTool(
  'route_media',
  {
    title: 'Route a media task to its provider',
    description: 'Given a media task class (video_generation, image_generation, tts_voice, audio_transcription, audio_edit, audio_master, video_host), return the media routing policy entry: tool + model(s) + the vault key NAME + endpoint. Policy only, no dispatch, no spend.',
    inputSchema: { taskType: z.string().describe('the media task class') },
  },
  async ({ taskType }) => {
    try {
      const eng = await getEngine();
      const entry = eng.routeMedia(taskType);
      if (!entry) return ok({ taskType, entry: null, known: Object.keys(eng.MEDIA_ROUTER_MATRIX || {}) });
      return ok({ taskType, entry });
    } catch (e) { return fail(String(e.message || e)); }
  },
);

server.registerTool(
  'list_council',
  {
    title: 'List research-council lineups + dispatchable models',
    description: 'Return the research-council debate lineups (default/fanout/research5) and the full set of dispatchable provider:model ids. Read-only, no spend.',
    inputSchema: {},
  },
  async () => {
    try {
      const eng = await getEngine();
      return ok({
        researchLineups: eng.RESEARCH_COUNCIL_LINEUPS,
        dispatchable: [...(eng.DISPATCHABLE_MODEL_IDS || [])],
      });
    } catch (e) { return fail(String(e.message || e)); }
  },
);

server.registerTool(
  'run_council',
  {
    title: 'Run a multi-model council (spends money - gated)',
    description: 'Fan a question out to a council lineup and return each model\'s response. lineup is optional: an array of provider:model ids, a named lineup ("default" | "fanout" | "research5"), or a single model id; omitted → the cheapest DEFAULT_LINEUP. Gated by COUNCIL_DRY_RUN (echo only), COUNCIL_MAX_CALL_USD (per-call cap, default $5), and MONTHLY_BUDGET_USD.',
    inputSchema: {
      question: z.string().describe('the question to send to every model in the lineup'),
      lineup: z.union([z.array(z.string()), z.string()]).optional().describe('array of ids, a named lineup, or one id; omitted = cheapest default'),
    },
  },
  async ({ question, lineup }) => runEngineTool({ toolName: 'run_council', prompt: question, models: lineup }),
);

server.registerTool(
  'run_researcher',
  {
    title: 'Run a research-framed council fan-out (spends money - gated)',
    description: 'Like run_council but frames the prompt for rigorous, cited research and synthesis. lineup optional (defaults to the cheapest DEFAULT_LINEUP; pass "fanout" or "research5" for a broader debate). Same COUNCIL_DRY_RUN / COUNCIL_MAX_CALL_USD / MONTHLY_BUDGET_USD gates.',
    inputSchema: {
      question: z.string().describe('the research question'),
      lineup: z.union([z.array(z.string()), z.string()]).optional().describe('array of ids, a named lineup, or one id; omitted = cheapest default'),
    },
  },
  async ({ question, lineup }) => runEngineTool({ toolName: 'run_researcher', prompt: question, models: lineup, opts: { systemPrompt: RESEARCHER_SYSTEM_PROMPT } }),
);

server.registerTool(
  'run_dealbreaker',
  {
    title: 'Adjudicate a research report\'s claims (spends money - gated)',
    description: 'Send a research report (inline text, or a path to a report file) to a lineup for claim-by-claim adjudication: keep verified/corroborated claims, cut unsupported/contradicted ones, and return a cleaned report plus an audit list. lineup optional (cheapest default). Same COUNCIL_DRY_RUN / COUNCIL_MAX_CALL_USD / MONTHLY_BUDGET_USD gates.',
    inputSchema: {
      report: z.string().describe('the report body, or a filesystem path to a report file'),
      lineup: z.union([z.array(z.string()), z.string()]).optional().describe('array of ids, a named lineup, or one id; omitted = cheapest default'),
    },
  },
  async ({ report, lineup }) => runEngineTool({ toolName: 'run_dealbreaker', prompt: buildDealbreakerPrompt(loadReportText(report)), models: lineup }),
);

// Only open a stdio transport when run as the actual MCP server process, so that
// importing this module for unit tests never tries to connect a transport.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export { server };
