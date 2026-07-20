#!/usr/bin/env node
/**
 * career-ops-server.mjs, narrow MCP server wrapping the job-search pipeline.
 *
 * Own-tool wrap #2 (docs/mcp-layer.md). Exposes three tools over the existing
 * career-ops CLI runners, so any agent can drive the pipeline without knowing
 * the script layout. It SHELLS OUT to the runners rather than importing them:
 * career-ops is a frozen working tree, and a child process cannot accidentally
 * mutate this server's module state.
 *
 * Read-mostly by design. queue_status and triage_next are read-only. apply_pack
 * CREATES FILES, so it is gated: it refuses unless confirm:true is passed, and
 * it reports what it would do otherwise. The gate exists because an agent that
 * can silently scaffold folders in a frozen repo is a bad trade for convenience.
 *
 * Public code carries NO private path: the repo location comes from
 * CAREER_OPS_PATH (env) or the gitignored private/mcp-config.mjs, the same
 * public-code / private-config split the council wrap and the router use.
 *
 * Tools:
 *   - queue_status()              -> outreach + application queue counts
 *   - triage_next()               -> the heuristic next-action recommendation (free, no model spend)
 *   - apply_pack(row, confirm)    -> scaffold an apply-pack folder for a row (GATED)
 *
 * Run:  CAREER_OPS_PATH=/abs/path/to/career-ops node src/mcp/career-ops-server.mjs
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

const execFileAsync = promisify(execFile);
const EXEC_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 20_000;

async function resolveRepoPath() {
  if (process.env.CAREER_OPS_PATH) return process.env.CAREER_OPS_PATH;
  try {
    const cfg = await import('../../private/mcp-config.mjs');
    return (cfg.default || cfg).careerOpsPath || null;
  } catch {
    return null;
  }
}

let repoPromise = null;
async function getRepo() {
  if (!repoPromise) {
    repoPromise = (async () => {
      const path = await resolveRepoPath();
      if (!path) {
        throw new Error('career-ops not configured, set CAREER_OPS_PATH or private/mcp-config.mjs { careerOpsPath }');
      }
      // Fail loudly on a misconfigured path rather than surfacing a confusing
      // ENOENT from every individual tool call.
      await access(join(path, 'package.json')).catch(() => {
        throw new Error(`career-ops path does not look like the repo (no package.json): ${path}`);
      });
      return path;
    })();
  }
  return repoPromise;
}

const ok = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });
const fail = (msg) => ({ content: [{ type: 'text', text: `error: ${msg}` }], isError: true });

/** Run a career-ops script and return its stdout, truncated. Never throws. */
async function runScript(script, args = []) {
  const cwd = await getRepo();
  try {
    const { stdout, stderr } = await execFileAsync('node', [script, ...args], {
      cwd,
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
    });
    const out = (stdout || '').slice(0, MAX_OUTPUT_CHARS);
    return { ok: true, stdout: out, truncated: (stdout || '').length > MAX_OUTPUT_CHARS, stderr: (stderr || '').slice(0, 2000) };
  } catch (e) {
    // A non-zero exit is a real result, not a crash: report it as a failed run
    // with whatever the script managed to say.
    return {
      ok: false,
      exitCode: e.code ?? null,
      killed: Boolean(e.killed),
      stdout: (e.stdout || '').slice(0, MAX_OUTPUT_CHARS),
      stderr: (e.stderr || String(e.message)).slice(0, 4000),
    };
  }
}

const server = new McpServer({ name: 'career-ops', version: '0.1.0' });

server.registerTool(
  'queue_status',
  {
    title: 'Job-search queue status',
    description: 'Summary counts for the outreach and application queues: what is due, what is pending, what is in flight. Read-only, no spend, no writes.',
    inputSchema: {},
  },
  async () => {
    // Reads the queue artifacts directly rather than shelling to a runner.
    // package.json's `outreach` script points at scripts/log-touch.mjs, which
    // does not exist anywhere in the repo (a ghost script; career-ops even ships
    // a lint:ghost-scripts check for this class). Reading the JSON the pipeline
    // actually writes is both more honest and genuinely read-only.
    let repo;
    try {
      repo = await getRepo();
    } catch (e) {
      return fail(String(e.message || e));
    }

    const out = { source: 'data/*.json (direct read, no scripts executed)' };
    for (const [label, rel] of [
      ['applyNow', 'data/apply-now-queue.json'],
      ['enrichment', 'data/enrichment-queue.json'],
    ]) {
      try {
        const raw = await readFile(join(repo, rel), 'utf8');
        const doc = JSON.parse(raw);
        const items = Array.isArray(doc.ranked) ? doc.ranked : Array.isArray(doc.queue) ? doc.queue : null;
        out[label] = {
          file: rel,
          count: items ? items.length : null,
          totalRows: doc.total_rows ?? null,
          generatedAt: doc.generated_at ?? doc._meta?.generated_at ?? null,
        };
      } catch (e) {
        // Absence is reported as absence, never as a zero.
        out[label] = { file: rel, error: String(e.message || e) };
      }
    }
    return ok(out);
  },
);

server.registerTool(
  'triage_next',
  {
    title: 'Next recommended job-search action',
    description: 'Recompute next-action recommendations for outreach contacts using the free heuristic recommender. Does NOT run the paid multi-model consensus path. Read-only with respect to your decisions; no model spend.',
    inputSchema: {},
  },
  async () => {
    const res = await runScript('scripts/recommend-next-action.mjs');
    if (!res.ok) return fail(`triage_next failed (exit ${res.exitCode}): ${res.stderr}`);
    return ok({ mode: 'heuristic', spend: 'none', output: res.stdout, truncated: res.truncated });
  },
);

server.registerTool(
  'apply_pack',
  {
    title: 'Scaffold an apply-pack folder (gated, writes files)',
    description: 'Scaffold apply-pack/{row}-{slug}/ for a row in applications.md. THIS WRITES FILES. Without confirm:true it performs a dry run and reports what it would create. Never pass force unless the caller explicitly asked to overwrite an existing folder.',
    inputSchema: {
      row: z.number().int().positive().describe('the row number in data/applications.md'),
      confirm: z.boolean().default(false).describe('must be true to actually create files'),
      force: z.boolean().default(false).describe('overwrite an existing apply-pack folder'),
    },
  },
  async ({ row, confirm, force }) => {
    if (!confirm) {
      return ok({
        dryRun: true,
        wouldRun: `node scripts/build-apply-pack.mjs --row=${row}${force ? ' --force' : ''}`,
        note: 'No files were created. Re-call with confirm:true to execute.',
      });
    }
    const args = ['scripts/build-apply-pack.mjs', `--row=${row}`];
    if (force) args.push('--force');
    const res = await runScript(args[0], args.slice(1));
    if (!res.ok) return fail(`apply_pack failed (exit ${res.exitCode}): ${res.stderr}`);
    return ok({ dryRun: false, row, force, output: res.stdout });
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
