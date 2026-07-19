#!/usr/bin/env node
/**
 * council-server.mjs — narrow MCP server wrapping the multi-model council engine.
 *
 * Exposes the engine's ROUTING POLICY as three read-only tools so any agent
 * (Claude Code, Cursor) can ask "what model/tool should this task go to?" without
 * importing the engine or spending a cent. Running an actual paid council fan-out
 * is deliberately NOT exposed here — it costs money and must pass the approval
 * gate (that stays behind the engine's run-council.mjs + approval flow).
 *
 * Public code carries NO private path: the engine location comes from
 * COUNCIL_ENGINE_PATH (env) or the gitignored private/mcp-config.mjs — the same
 * public-code / private-config split the router uses.
 *
 * Tools:
 *   - route_task(taskType)  → the provider:model lineup the router picks
 *   - route_media(taskType) → the media routing policy entry (tool + key NAME)
 *   - list_council()        → the research-council debate lineups + dispatchable ids
 *
 * Run:  COUNCIL_ENGINE_PATH=/abs/path/to/career-ops/lib/council.mjs \
 *         node src/mcp/council-server.mjs
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
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
        throw new Error('council engine not configured — set COUNCIL_ENGINE_PATH or private/mcp-config.mjs { councilEnginePath }');
      }
      return import(path);
    })();
  }
  return enginePromise;
}

const ok = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });
const fail = (msg) => ({ content: [{ type: 'text', text: `error: ${msg}` }], isError: true });

const server = new McpServer({ name: 'council', version: '0.1.0' });

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

const transport = new StdioServerTransport();
await server.connect(transport);
