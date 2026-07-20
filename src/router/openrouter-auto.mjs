/**
 * openrouter-auto.mjs, router substrate config + target resolution.
 *
 * TOPOLOGY (the stack-ops Run-1 decision B/C, end-state for Run 3's Cursor deploy):
 *
 *   Cursor (desktop/mobile)
 *     │  "Override OpenAI Base URL" → the LOCAL ROUTER's public hostname
 *     │  (a Cloudflare tunnel or a Tailscale MagicDNS host, Cursor SSRF-blocks
 *     │   raw localhost / private IPs, so 127.0.0.1 will NOT work)
 *     ▼
 *   Local router  ──►  privacy-gate.classify(request)
 *     │                   ├─ sensitive → Anthropic-direct  (no third-party hop)
 *     │                   └─ generic   → OpenRouter Auto    (cheap external router)
 *     ▼
 *   Model
 *
 * The gate runs BEFORE a single token leaves the machine. Only generic,
 * non-sensitive requests ever reach OpenRouter. This module holds the endpoint
 * constants + resolveTarget(), which maps a gate decision to a concrete
 * forwarding target. Dependency-free; no network here (a forwarder wires it up).
 */

import { ROUTE } from './privacy-gate.mjs';

// OpenRouter Auto, the single meta-model that routes to the best-value provider.
// Verified 2026-07-19: the canonical slug is `openrouter/auto` (NOT `auto-beta`).
export const OPENROUTER_AUTO_MODEL = 'openrouter/auto';

export const ENDPOINTS = Object.freeze({
  // Standard OpenAI-compatible endpoint (Ask mode / plain chat-completions).
  OPENROUTER_STANDARD: 'https://openrouter.ai/api/v1',
  // Cursor-specialized endpoint: normalizes Cursor Agent-mode's tool-call payload
  // shape so Agent mode does not hard-fail against a thin gateway. Verified as the
  // documented path for Cursor + OpenRouter (Run-1 decision C).
  OPENROUTER_CURSOR: 'https://openrouter.ai/api/v1/cursor',
  // Trusted provider for sensitive traffic (no third-party hop).
  ANTHROPIC_DIRECT: 'https://api.anthropic.com/v1',
});

// Default model to run on the sensitive path. Opus for judgment; a caller may
// downshift to Sonnet/Haiku for cheaper sensitive work, still Anthropic-direct.
export const ANTHROPIC_DIRECT_DEFAULT_MODEL = 'claude-opus-4-8';

export const CURSOR_SSRF_NOTE =
  'Cursor issues base-URL requests server-side, so it SSRF-blocks private IPs and ' +
  'raw localhost ("connection to private IP is blocked"). Expose the local router ' +
  'via a Cloudflare tunnel or a Tailscale MagicDNS hostname; never point Cursor at ' +
  'http://127.0.0.1:PORT directly.';

/**
 * resolveTarget(decision, opts), map a privacy-gate decision to a forwarding
 * target the local router uses to proxy the request.
 *
 * @param {{route:string}} decision  a classify() result (uses .route)
 * @param {object} [opts]
 * @param {boolean} [opts.agentMode] Cursor Agent mode → use the /cursor endpoint
 * @param {string}  [opts.autoModel] override the Auto model slug
 * @param {string}  [opts.anthropicModel] override the sensitive-path model
 * @returns {{provider:string, baseUrl:string, model:string, thirdParty:boolean, note?:string}}
 */
export function resolveTarget(decision, opts = {}) {
  const route = decision && decision.route;
  if (route === ROUTE.AUTO) {
    return {
      provider: 'openrouter',
      baseUrl: opts.agentMode ? ENDPOINTS.OPENROUTER_CURSOR : ENDPOINTS.OPENROUTER_STANDARD,
      model: opts.autoModel || OPENROUTER_AUTO_MODEL,
      thirdParty: true,
    };
  }
  // Default (incl. ROUTE.ANTHROPIC_DIRECT and any unexpected value): trusted path.
  return {
    provider: 'anthropic',
    baseUrl: ENDPOINTS.ANTHROPIC_DIRECT,
    model: opts.anthropicModel || ANTHROPIC_DIRECT_DEFAULT_MODEL,
    thirdParty: false,
    note: route === ROUTE.ANTHROPIC_DIRECT ? undefined : `unrecognized route "${route}", defaulted to trusted provider (deny-by-default)`,
  };
}

/**
 * cursorBaseUrl(localRouterHost, opts), the value to paste into Cursor's
 * "Override OpenAI Base URL". Points at the LOCAL ROUTER (behind a tunnel /
 * MagicDNS), not OpenRouter directly, the gate must run first.
 *
 * @param {string} localRouterHost e.g. 'https://router.example.ts.net' or a
 *                                  Cloudflare tunnel URL. Must NOT be localhost.
 * @param {object} [opts]
 * @param {boolean} [opts.agentMode]
 * @returns {string}
 */
export function cursorBaseUrl(localRouterHost, opts = {}) {
  if (!localRouterHost || /^https?:\/\/(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])/i.test(localRouterHost)) {
    throw new Error(`cursorBaseUrl: refusing localhost/private host, ${CURSOR_SSRF_NOTE}`);
  }
  const suffix = opts.agentMode ? '/v1/cursor' : '/v1';
  return localRouterHost.replace(/\/+$/, '') + suffix;
}
