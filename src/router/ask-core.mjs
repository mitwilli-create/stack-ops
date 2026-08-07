import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { assembleAgentContext as defaultContext } from '../agent/context-assembler.mjs';
import { answerLocalPrompt as defaultLocalAnswer } from '../agent/local-handlers.mjs';
import { routeRequest as defaultRoute, LANE } from './request-router.mjs';

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function loadFileBodies(paths = []) {
  return paths.map((path) => {
    try {
      return '\n\n===== ' + path + ' =====\n' + readFileSync(path, 'utf8');
    } catch (error) {
      return '\n\n===== ' + path + ' (unreadable: ' + (error.code || 'error') + ') =====\n';
    }
  }).join('');
}

async function loadEngine() {
  const configured = process.env.COUNCIL_ENGINE_PATH || process.env.STACK_OPS_COUNCIL_ENGINE_PATH;
  if (configured) return import(configured);
  try {
    const config = await import('../../private/mcp-config.mjs');
    const path = (config.default || config).councilEnginePath;
    if (path) return import(path);
  } catch {
    // Public checkout or absent private overlay. The caller gets the clear error.
  }
  throw new Error('council engine is not configured; set COUNCIL_ENGINE_PATH or private/mcp-config.mjs');
}

function summarizeResults(results) {
  return (results || []).map((result) => ({
    model: result.model,
    modelUsed: result.modelUsed,
    error: result.error || null,
    missingKeys: result.missingKeys || null,
  }));
}

async function dispatchFrontier(prompt, decision, context) {
  const engine = await loadEngine();
  const failures = [];
  for (const target of decision.targets) {
    const result = await engine.callCouncil({
      prompt,
      models: [target.handle],
      opts: {
        maxTokens: Number(process.env.STACK_OPS_MAX_OUTPUT_TOKENS) || 6000,
        grounded: decision.taskType === 'web_research'
          || decision.taskType === 'deep_research_synthesis'
          || decision.taskType === 'realtime_social',
        systemPrompt: context?.systemPrompt,
      },
    });
    const answer = result.results?.find((row) => row && typeof row.content === 'string' && row.content.trim());
    if (answer) return { answer: answer.content, target, result };
    failures.push({ target: target.handle, results: summarizeResults(result.results), missingKeys: result.missingKeys || [] });
  }
  throw new Error('no frontier target returned an answer: ' + JSON.stringify(failures));
}

async function dispatchToil(prompt, input, decision) {
  const args = ['cheap.mjs', '--task', decision.executionTask];
  for (const path of input.paths || []) args.push('--files', path);
  args.push(prompt);
  const result = await execFileAsync(process.execPath, args, {
    cwd: repoRoot,
    env: { ...process.env, CHEAP_NO_ESCALATE: '1' },
    timeout: Number(process.env.STACK_OPS_TOIL_TIMEOUT_MS) || 240_000,
    maxBuffer: 20 * 1024 * 1024,
  });
  return { answer: result.stdout, target: decision.targets[0], stderr: result.stderr };
}

export async function dispatchRoutedRequest({ prompt, input, decision, context }) {
  return decision.lane === LANE.TOIL
    ? dispatchToil(prompt, input, decision)
    : dispatchFrontier(prompt, decision, context);
}

/**
 * Shared request execution seam for Raycast, the local console, and tests.
 * Context is assembled before external dispatch and is passed as a system
 * prompt only to frontier calls. Local clock requests never reach a model.
 */
export async function runAsk(input = {}, dependencies = {}) {
  const paths = Array.isArray(input.paths) ? input.paths : [];
  const prompt = [input.text, input.stdin, loadFileBodies(paths)].filter(Boolean).join('\n').trim();
  if (!prompt) throw new Error('stack-ops ask: provide text, stdin, or --paths');

  const localAnswer = (dependencies.localAnswer || defaultLocalAnswer)(prompt);
  if (localAnswer) {
    return {
      answer: localAnswer,
      local: true,
      context: null,
      target: { handle: 'system-clock' },
      decision: { lane: 'local', taskType: 'local_clock', signals: ['local-clock'], selected: { handle: 'system-clock' } },
    };
  }

  const route = dependencies.route || defaultRoute;
  const decision = await route({ ...input, text: prompt });
  if (input.dryRun) return { answer: null, local: false, context: null, decision, target: decision.selected };
  if (decision.lane === LANE.LOCAL_ONLY) {
    return { answer: null, local: false, context: null, decision, target: null, refused: true };
  }

  const context = await (dependencies.context || defaultContext)({ ...input, prompt });
  const dispatch = dependencies.dispatch || dispatchRoutedRequest;
  const dispatched = await dispatch({ prompt, input, decision, context });
  return { ...dispatched, local: false, context, decision, target: dispatched.target || decision.selected };
}
