/**
 * privacy-gate.mjs — content-level routing gate for the stack-ops model router.
 *
 * Decides, per request, whether it may go to the cheap external router
 * (OpenRouter Auto) or MUST stay local / direct-to-Anthropic. This REPLACES the
 * old blanket "the whole repo is sensitive" deny with a content-level signal
 * check — which is both:
 *   - SAFER: catches sensitive content in ANY repo (including otherwise-generic
 *     ones), not just a hard-coded list of sensitive directories; and
 *   - CHEAPER: generic work routes to the cheap tier even inside a sensitive repo.
 *
 * DENY-BY-DEFAULT on ambiguity. This is a security control: when a request is
 * empty, malformed, or can't be assessed, classify() returns 'anthropic-direct'.
 * The safe error here is OVER-denying (route sensitive-looking work to the trusted
 * provider), never under-denying (leak to a third party).
 *
 * Pure, synchronous, dependency-free. No network, no LLM — it's a fast pre-router
 * that runs before a single token leaves the machine. Personal specifics (exact
 * private paths, employer names, extra PII) live in a GITIGNORED private config
 * (loadGateConfig); the generic defaults below are safe on their own.
 */

export const ROUTE = Object.freeze({
  ANTHROPIC_DIRECT: 'anthropic-direct', // trusted provider, no third-party hop
  AUTO: 'auto',                          // OpenRouter Auto (cheap external router)
});

export const SIGNAL = Object.freeze({
  SECRET: 'secret-or-key',
  PII: 'pii',
  PRIVATE_PATH: 'private-path',
  EMPLOYER: 'employer-proprietary',
  AMBIGUOUS: 'ambiguous',
});

// ── Generic secret / credential patterns ────────────────────────────────────
// Provider-prefixed tokens, PEM blocks, and NAME=value / key: value assignments.
// Kept specific enough that ordinary prose/code does not trip them.
const SECRET_PATTERNS = [
  /\b(?:sk|rk|pk)-[A-Za-z0-9]{16,}\b/,                         // OpenAI-style keys
  /\bxai-[A-Za-z0-9]{16,}\b/,                                   // xAI
  /\bAKIA[0-9A-Z]{16}\b/,                                       // AWS access key id
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,                             // GitHub tokens
  /\bAIza[0-9A-Za-z_\-]{20,}\b/,                                // Google API key
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,                           // Slack tokens
  /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/,                  // PEM private key
  /\b(?:api[_-]?key|secret|bearer|access[_-]?token|client[_-]?secret|password|passwd)\b\s*[:=]\s*['"]?[A-Za-z0-9\-_.]{12,}/i,
  /\b[A-Z][A-Z0-9_]{2,}_(?:API_KEY|APIKEY|TOKEN|SECRET|PASSWORD|KEY)\s*=\s*\S+/, // ENV_NAME=value
];

// ── Generic PII patterns ─────────────────────────────────────────────────────
const PII_PATTERNS = [
  /\b\d{3}-\d{2}-\d{4}\b/,                                      // US SSN
  /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/,      // email address
  /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/,   // US phone number
  /\b\d{1,5}\s+[A-Za-z0-9.\s]{3,30}\s+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way|Place|Pl)\b/i, // street address
  /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|6(?:011|5[0-9]{2})[0-9]{12})\b/, // credit card
  /\b(?:passport|driver'?s? licen[cs]e|national id)\b/i,       // ID document mentions
];

// ── Generic private-path markers ─────────────────────────────────────────────
// Personal specifics (exact repo names, apply-pack, hm-intel, etc.) come from the
// private config; these are safe defaults that apply to any machine.
const DEFAULT_PRIVATE_PATH_PATTERNS = [
  /(?:^|\/)\.secrets(?:\/|$)/,
  /(?:^|\/)\.ssh(?:\/|$)/,
  /(?:^|[/\\])\.env(?:\.[\w-]+)?$/,
  /(?:^|\/)private(?:\/|$)/,
  /\b(?:credentials|id_rsa|id_ed25519|service-account[\w-]*\.json)\b/,
  /\bapi-keys?\.env\b/,
];

// After this date Mitchell's Google access ends; before it, employer-proprietary
// markers are an especially hard deny. Confidentiality obligations survive the
// access-end date, so the signal keeps denying afterward — the date only records
// when the live-access risk window closes. ISO date; compared lexically.
const EMPLOYER_CLOCK_ISO = '2026-08-23';

/**
 * Load the effective gate config: generic defaults merged UNDER the gitignored
 * private config (if present) and any inline overrides (highest precedence).
 * When the private config is absent — e.g. a fresh public checkout of this repo —
 * the generic defaults still provide a safe, deny-by-default gate.
 *
 * The private config module (../../private/router-config.mjs) exports:
 *   { privatePathPatterns?: RegExp[], employerPatterns?: RegExp[],
 *     piiPatterns?: RegExp[], allowlist?: RegExp[] }
 *
 * @param {object} [overrides]
 * @param {Promise<object>|object|null} [overrides.privateConfig] pre-loaded config
 * @returns {object} effective config
 */
export function buildConfig(privateConfig = null, overrides = {}) {
  const pc = privateConfig || {};
  return {
    secretPatterns: [...SECRET_PATTERNS, ...(pc.secretPatterns || []), ...(overrides.secretPatterns || [])],
    piiPatterns: [...PII_PATTERNS, ...(pc.piiPatterns || []), ...(overrides.piiPatterns || [])],
    privatePathPatterns: [...DEFAULT_PRIVATE_PATH_PATTERNS, ...(pc.privatePathPatterns || []), ...(overrides.privatePathPatterns || [])],
    employerPatterns: [...(pc.employerPatterns || []), ...(overrides.employerPatterns || [])],
    // allowlist: patterns that, if they match a path, EXEMPT it from the private-path
    // signal (e.g. a public docs/ dir inside an otherwise-private repo). Never
    // exempts secret/PII/employer content — those deny regardless of path.
    allowlist: [...(pc.allowlist || []), ...(overrides.allowlist || [])],
    employerClockIso: overrides.employerClockIso || pc.employerClockIso || EMPLOYER_CLOCK_ISO,
  };
}

/**
 * Try to load the gitignored private config. Returns null if absent (public
 * checkout) — the caller falls back to generic defaults. Async because it uses a
 * dynamic import; classify() also has a sync path that takes a pre-built config.
 * @returns {Promise<object|null>}
 */
export async function loadPrivateConfig() {
  try {
    const mod = await import('../../private/router-config.mjs');
    return mod.default || mod.config || mod;
  } catch {
    return null; // absent in a public checkout — generic defaults are still safe
  }
}

function anyMatch(patterns, str) {
  for (const re of patterns) {
    // Reset lastIndex defensively in case a caller passes a /g regex.
    re.lastIndex = 0;
    if (re.test(str)) return re;
  }
  return null;
}

/**
 * classify(input, config) — the routing decision.
 *
 * @param {object} input
 * @param {string} [input.text]  the prompt / request body
 * @param {string[]} [input.paths] file paths referenced by the request
 * @param {string} [input.cwd]   working directory
 * @param {string} [input.repo]  repo name/root
 * @param {object} [config]      from buildConfig(); defaults to generic-only
 * @returns {{route:string, sensitive:boolean, reasons:Array<{signal:string,detail:string}>}}
 */
export function classify(input, config = buildConfig()) {
  const reasons = [];

  // Deny-by-default: a missing/blank/malformed request is treated as sensitive.
  if (!input || typeof input !== 'object') {
    return { route: ROUTE.ANTHROPIC_DIRECT, sensitive: true, reasons: [{ signal: SIGNAL.AMBIGUOUS, detail: 'no structured input — deny-by-default' }] };
  }
  const text = typeof input.text === 'string' ? input.text : '';
  const rawPaths = [
    ...(Array.isArray(input.paths) ? input.paths : []),
    input.cwd,
    input.repo,
  ].filter(v => typeof v === 'string' && v.length);

  if (!text && rawPaths.length === 0) {
    return { route: ROUTE.ANTHROPIC_DIRECT, sensitive: true, reasons: [{ signal: SIGNAL.AMBIGUOUS, detail: 'empty request — deny-by-default' }] };
  }

  // 1. Secrets / credentials in the text.
  const secretHit = anyMatch(config.secretPatterns, text);
  if (secretHit) reasons.push({ signal: SIGNAL.SECRET, detail: `matched ${secretHit.source.slice(0, 48)}` });

  // 2. PII in the text.
  const piiHit = anyMatch(config.piiPatterns, text);
  if (piiHit) reasons.push({ signal: SIGNAL.PII, detail: `matched ${piiHit.source.slice(0, 48)}` });

  // 3. Employer-proprietary markers (text OR paths). Confidentiality survives the
  //    access-end date, so this always denies when it fires.
  const employerHit = anyMatch(config.employerPatterns, text) || anyMatch(config.employerPatterns, rawPaths.join(' '));
  if (employerHit) reasons.push({ signal: SIGNAL.EMPLOYER, detail: `matched ${employerHit.source.slice(0, 48)} (clock ${config.employerClockIso})` });

  // 4. Private paths — in the referenced paths OR mentioned in the text — unless
  //    an allowlist entry exempts the path. Secret/PII/employer content above is
  //    NEVER exempted by the allowlist.
  const pathBlob = rawPaths.join('\n');
  const allowlisted = anyMatch(config.allowlist, pathBlob);
  const pathHit = anyMatch(config.privatePathPatterns, pathBlob) || anyMatch(config.privatePathPatterns, text);
  if (pathHit && !allowlisted) reasons.push({ signal: SIGNAL.PRIVATE_PATH, detail: `matched ${pathHit.source.slice(0, 48)}` });

  const sensitive = reasons.length > 0;
  return {
    route: sensitive ? ROUTE.ANTHROPIC_DIRECT : ROUTE.AUTO,
    sensitive,
    reasons,
  };
}

/**
 * classifyAsync(input, overrides) — convenience wrapper that loads the private
 * config (if present) before classifying. Prefer this at the integration edge;
 * use the sync classify() with a pre-built config in hot paths / tests.
 */
export async function classifyAsync(input, overrides = {}) {
  const pc = await loadPrivateConfig();
  return classify(input, buildConfig(pc, overrides));
}
