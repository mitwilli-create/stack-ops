#!/usr/bin/env node
/**
 * media-server.mjs, narrow MCP server wrapping the media pipeline.
 *
 * Own-tool wrap #3 (docs/mcp-layer.md). Four tools covering the media task
 * classes in the engine's MEDIA_ROUTER_MATRIX: image, video, speech, transcript.
 *
 * DESIGN: this server RESOLVES POLICY and, only on explicit confirmation,
 * DISPATCHES. Every media call costs real money, so the default for all four
 * tools is a dry run that reports the provider, model, endpoint and the vault
 * key NAME it would use. Passing confirm:true is what spends. This mirrors the
 * council wrap, which deliberately does not expose a fire-and-forget paid
 * fan-out.
 *
 * NEVER a secret VALUE. The matrix carries key NAMES; the value is read from
 * the process environment at dispatch time and is never logged, never returned,
 * and never written to any artifact.
 *
 * Public code carries NO private path: the engine location comes from
 * COUNCIL_ENGINE_PATH (env) or the gitignored private/mcp-config.mjs.
 *
 * Tools (all default to dry-run):
 *   - generate_image(prompt, confirm)
 *   - generate_video(prompt, confirm)
 *   - tts(text, voice, confirm)
 *   - transcribe(audioPath, confirm)
 *
 * Run:  COUNCIL_ENGINE_PATH=/abs/path/to/career-ops/lib/council.mjs \
 *         node src/mcp/media-server.mjs
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
        throw new Error('media engine not configured, set COUNCIL_ENGINE_PATH or private/mcp-config.mjs { councilEnginePath }');
      }
      return import(path);
    })();
  }
  return enginePromise;
}

const ok = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });
const fail = (msg) => ({ content: [{ type: 'text', text: `error: ${msg}` }], isError: true });

/**
 * Resolve the routing policy for a media class and report credential presence
 * WITHOUT reading the value. Returns a shape safe to hand back to the model.
 */
async function resolvePolicy(taskClass) {
  const eng = await getEngine();
  const entry = eng.routeMedia(taskClass);
  if (!entry) {
    const known = Object.keys(eng.MEDIA_ROUTER_MATRIX || {});
    throw new Error(`no routing policy for media class "${taskClass}". Known classes: ${known.join(', ')}`);
  }
  // The matrix stores key NAMES in `envKey`. Report set/unset only, never the
  // value. If the field is ever renamed upstream this must fail loudly rather
  // than silently reporting `null` and leaving the credential gate inert, which
  // is precisely the "check that cannot go red" failure this repo warns about.
  const keyName = entry.envKey ?? null;
  if (keyName === null) {
    throw new Error(`media matrix entry for "${taskClass}" has no envKey field. Shape may have changed upstream: ${JSON.stringify(Object.keys(entry))}`);
  }
  const credentialPresent = Boolean(process.env[keyName]);
  return { entry, keyName, credentialPresent };
}

/** Shared dry-run/confirm wrapper. Dispatch is intentionally not implemented here. */
async function policyOrDispatch(taskClass, confirm, params) {
  let policy;
  try {
    policy = await resolvePolicy(taskClass);
  } catch (e) {
    return fail(String(e.message || e));
  }

  const base = {
    taskClass,
    provider: policy.entry.tool ?? null,
    models: policy.entry.models ?? null,
    endpoint: policy.entry.endpoint ?? null,
    policyNote: policy.entry.note ?? null,
    keyName: policy.keyName,
    credentialPresent: policy.credentialPresent,
  };

  if (!confirm) {
    return ok({ ...base, dryRun: true, params, note: 'Policy only. No call was made and nothing was spent. Re-call with confirm:true to dispatch.' });
  }

  if (policy.keyName && !policy.credentialPresent) {
    return fail(`cannot dispatch ${taskClass}: ${policy.keyName} is not set in the environment`);
  }

  // Dispatch is deliberately routed through the engine rather than reimplemented
  // here, so there is exactly one place that knows how to call each provider.
  try {
    const eng = await getEngine();
    if (typeof eng.dispatchMedia !== 'function') {
      return fail(`the engine does not export dispatchMedia(), so this wrap cannot spend on your behalf yet. Resolved policy: ${JSON.stringify(base)}. Run the provider call through the engine's own runner.`);
    }
    const result = await eng.dispatchMedia(taskClass, params);
    return ok({ ...base, dryRun: false, result });
  } catch (e) {
    return fail(`${taskClass} dispatch failed: ${String(e.message || e)}`);
  }
}

const server = new McpServer({ name: 'media', version: '0.1.0' });

server.registerTool(
  'generate_image',
  {
    title: 'Generate an image (policy by default, spends only on confirm)',
    description: 'Resolve the image-generation provider and model from the media router. Returns policy only unless confirm:true, which dispatches a PAID call.',
    inputSchema: {
      prompt: z.string().describe('the image prompt'),
      confirm: z.boolean().default(false).describe('true dispatches a paid call'),
    },
  },
  ({ prompt, confirm }) => policyOrDispatch('image_generation', confirm, { prompt }),
);

server.registerTool(
  'generate_video',
  {
    title: 'Generate a video (policy by default, spends only on confirm)',
    description: 'Resolve the video-generation provider and model from the media router. Returns policy only unless confirm:true, which dispatches a PAID call. Video is the most expensive class in the matrix.',
    inputSchema: {
      prompt: z.string().describe('the video prompt'),
      confirm: z.boolean().default(false).describe('true dispatches a paid call'),
    },
  },
  ({ prompt, confirm }) => policyOrDispatch('video_generation', confirm, { prompt }),
);

server.registerTool(
  'tts',
  {
    title: 'Text to speech (policy by default, spends only on confirm)',
    description: 'Resolve the TTS provider and voice model from the media router. Returns policy only unless confirm:true, which dispatches a PAID call.',
    inputSchema: {
      text: z.string().describe('the text to speak'),
      voice: z.string().optional().describe('voice id or name, provider-specific'),
      confirm: z.boolean().default(false).describe('true dispatches a paid call'),
    },
  },
  ({ text, voice, confirm }) => policyOrDispatch('tts_voice', confirm, { text, voice }),
);

server.registerTool(
  'transcribe',
  {
    title: 'Transcribe audio (policy by default, spends only on confirm)',
    description: 'Resolve the transcription and diarization provider from the media router. Returns policy only unless confirm:true, which dispatches a PAID call.',
    inputSchema: {
      audioPath: z.string().describe('absolute path to the audio file'),
      confirm: z.boolean().default(false).describe('true dispatches a paid call'),
    },
  },
  ({ audioPath, confirm }) => policyOrDispatch('audio_transcription', confirm, { audioPath }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
