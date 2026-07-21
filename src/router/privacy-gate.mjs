/**
 * privacy-gate.mjs, content-level routing gate for the stack-ops model router.
 *
 * Decides, per request, whether it may go to the cheap external router
 * (OpenRouter Auto) or MUST stay local / direct-to-Anthropic. This REPLACES the
 * old blanket "the whole repo is sensitive" deny with a content-level signal
 * check, which is both:
 *   - SAFER: catches sensitive content in ANY repo (including otherwise-generic
 *     ones), not just a hard-coded list of sensitive directories; and
 *   - CHEAPER: generic work routes to the cheap tier even inside a sensitive repo.
 *
 * DENY-BY-DEFAULT on ambiguity. This is a security control: when a request is
 * empty, malformed, or can't be assessed, classify() returns 'anthropic-direct'.
 * The safe error here is OVER-denying (route sensitive-looking work to the trusted
 * provider), never under-denying (leak to a third party).
 *
 * Pure, synchronous, dependency-free. No network, no LLM, it's a fast pre-router
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
  INFRA: 'infra-credential-exposure',
  AMBIGUOUS: 'ambiguous',
});

// ─────────────────────────────────────────────────────────────────────────────
// NARROWED 2026-07-19 to Mitchell's explicit ruling. Read this before widening
// anything back: the previous gate was far broader and was costing money by
// over-routing ordinary work to Anthropic.
//
// Ruled ALLOW, these route CHEAP and must NOT be gated: home address · phone ·
// email · current employer · health information · relocation plans · layoff
// status · financial details · general identity documents · unpublished
// career/strategy material · third-party data (hm-intel notes, other people's
// contact details) · the voice-os corpus · session transcripts · ~/.claude ·
// career-ops and relocation-os generally. This was an informed decision after a
// risk review, not an oversight. Do not re-gate them.
//
// The narrow gate DEPENDS on two controls that replace the gating he declined:
//   (i)  zero-data-retention is mandatory on the cheap path (enforced by the
//        caller/forwarder, not here, a provider that cannot honour zdr gets no
//        cheap-path traffic at all); and
//   (ii) THIS credential scanner, which is now load-bearing: with path gates
//        this narrow it is the only control between a pasted key and a third
//        party. It scans FULL content, never a sample.
// ─────────────────────────────────────────────────────────────────────────────

// ── Credential patterns, the load-bearing control ───────────────────────────
// Every format below has a dedicated test in router.test.mjs. Add a format here
// and add its test in the same change; this list is the security boundary.
//
// KNOWN LIMITATION (verify 2026-07-20, ruled scope-note + ZDR): this is a
// PREFIX/LABEL scanner. A label-less high-entropy blob (a bare 40/64-char hex or
// base64 string with no recognizable prefix and no key=/token: label) will NOT
// match and routes CHEAP. A Shannon-entropy heuristic was rejected: on a coding
// substrate full of git SHAs, content hashes, and UUIDs it over-filters ordinary
// work constantly. The residual risk is covered by the mandatory zero-data-
// retention control on the cheap path (AGENTS.md: a provider that cannot honour
// ZDR gets no traffic). Do not add entropy detection without a ruling that
// accepts the over-filter cost.
const SECRET_PATTERNS = [
  /\b(?:sk|rk|pk)-[A-Za-z0-9_\-]{16,}/,                         // OpenAI-style (incl. sk-ant-, sk-proj-)
  /\bxai-[A-Za-z0-9]{16,}\b/,                                   // xAI
  /\bAKIA[0-9A-Z]{16}\b/,                                       // AWS access key id
  /\bASIA[0-9A-Z]{16}\b/,                                       // AWS temporary key id
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,                             // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,                           // GitHub fine-grained PAT
  /\bAIza[0-9A-Za-z_\-]{20,}\b/,                                // Google API key
  /\bAQ\.Ab[A-Za-z0-9_\-]{10,}/,                                // Google OAuth / AQ.Ab-prefixed token
  /\bya29\.[A-Za-z0-9_\-]{20,}/,                                // Google OAuth access token
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,                           // Slack tokens
  /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/i,                  // PEM private key block (case-insensitive: header is normally upper, but downcase must not evade)
  /\bAuthorization\s*:\s*Bearer\s+[A-Za-z0-9._\-]{16,}/i,       // bearer token in a header
  /\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}/, // JWT
  /\b(?:api[_-]?key|secret|bearer|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|totp[_-]?secret)\b\s*[:=]\s*['"]?[A-Za-z0-9\-_.]{12,}/i,
  /\b[A-Z][A-Z0-9_]{2,}_(?:API_KEY|APIKEY|TOKEN|SECRET|PASSWORD|KEY)\s*=\s*\S+/, // .env-style ENV_NAME=value
  // Payment card numbers (Visa / Mastercard / Amex / Discover). Restored by
  // interview 2026-07-19 and filed HERE, under credentials, rather than under PII.
  // The distinction is the point: "financial details" (severance amount, salary
  // band) are facts about Mitchell and route CHEAP by his ruling. A card number is
  // a BEARER INSTRUMENT, whoever holds it can spend it, which puts it in the same
  // class as an API key, not the same class as a salary figure. Asymmetric failure
  // modes: a false positive costs one request routed to Anthropic; a false negative
  // puts a live card number in a third party's logs. Two forms: contiguous
  // digits, AND the dominant real-world grouped form with single space/hyphen
  // separators (4-4-4-4 for Visa/MC/Discover, 4-6-5 for Amex). Without the
  // grouped form, "4111 1111 1111 1111" leaked to the cheap path.
  /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|6(?:011|5[0-9]{2})[0-9]{12})\b/,
  /\b(?:4[0-9]{3}|5[1-5][0-9]{2}|6(?:011|5[0-9]{2}))(?:[ -][0-9]{4}){3}\b/,   // 16-digit grouped (Visa/MC/Discover)
  /\b3[47][0-9]{2}[ -][0-9]{6}[ -][0-9]{5}\b/,                                 // 15-digit grouped (Amex, 4-6-5)
];

// ── PII, collapsed to the two identifiers he still considers sensitive ──────
// Everything else formerly here (email, phone, street address, credit card,
// ID-document mentions) was REMOVED per the ruling. Do not reinstate without a
// new ruling.
const PII_PATTERNS = [
  /\b\d{3}([-.])\d{2}\1\d{4}\b/,                               // US SSN (dash or dot; space dropped because it over-filtered SKUs/invoices with no leak-risk gain)
  /\bpassport\s*(?:no\.?|number|#)?\s*[:#]?\s*[A-Z0-9]{6,9}\b/i, // passport number
];

// ── Private paths, only those that reliably hold credentials or NDA material ─
// Removed per the ruling: the blanket /private/ marker, career-ops, relocation-os,
// ~/.claude, and session transcripts. Kept: credential stores and shell rc files
// that source the vault. Client/NDA and employer paths come from the private
// config (they are personal specifics, not generic defaults).
const DEFAULT_PRIVATE_PATH_PATTERNS = [
  /(?:^|\/)\.secrets(?:\/|$)/,
  /(?:^|\/)\.ssh(?:\/|$)/,
  /(?:^|[/\\])\.env(?:\.[\w-]+)?$/,
  /(?:^|\/)\.(?:zshrc|zshenv|zprofile|bash_profile|bashrc|profile)$/, // rc files that source the vault
  /\b(?:credentials|id_rsa|id_ed25519|service-account[\w-]*\.json)\b/,
  /\bapi-keys?\.env\b/,
];

// ── INFRA, kept, but the reason is CREDENTIAL EXPOSURE, not privacy ─────────
// Secrets operations, the publish/secret-scan gate, and council infra config all
// tend to quote key names and vault layout in-line.
const DEFAULT_INFRA_PATTERNS = [
  /\b(?:rotate|revoke|provision)\s+(?:the\s+)?(?:api\s+)?key\b/i,
  /\bsecret[- ]scan\b|\bsecrets? (?:ops|operation|rotation|hardening)\b/i,
  /\bsecrets-launchd-setenv\b|\blaunchctl setenv\b/i,
  /\bvault\b.*\b(?:key|secret|token)\b/i,
];

// After this date Mitchell's Google access ends; before it, employer-proprietary
// markers are an especially hard deny. Confidentiality obligations survive the
// access-end date, so the signal keeps denying afterward, the date only records
// when the live-access risk window closes. ISO date; compared lexically.
const EMPLOYER_CLOCK_ISO = '2026-08-23';

/**
 * Load the effective gate config: generic defaults merged UNDER the gitignored
 * private config (if present) and any inline overrides (highest precedence).
 * When the private config is absent, e.g. a fresh public checkout of this repo
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
    infraPatterns: [...DEFAULT_INFRA_PATTERNS, ...(pc.infraPatterns || []), ...(overrides.infraPatterns || [])],
    // allowlist: patterns that, if they match a path, EXEMPT it from the private-path
    // signal (e.g. a public docs/ dir inside an otherwise-private repo). Never
    // exempts secret/PII/employer content, those deny regardless of path.
    allowlist: [...(pc.allowlist || []), ...(overrides.allowlist || [])],
    employerClockIso: overrides.employerClockIso || pc.employerClockIso || EMPLOYER_CLOCK_ISO,
  };
}

/**
 * Try to load the gitignored private config. Returns null if absent (public
 * checkout), the caller falls back to generic defaults. Async because it uses a
 * dynamic import; classify() also has a sync path that takes a pre-built config.
 * @returns {Promise<object|null>}
 */
export async function loadPrivateConfig() {
  try {
    const mod = await import('../../private/router-config.mjs');
    return mod.default || mod.config || mod;
  } catch {
    return null; // absent in a public checkout, generic defaults are still safe
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
 * classify(input, config), the routing decision.
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
    return { route: ROUTE.ANTHROPIC_DIRECT, sensitive: true, reasons: [{ signal: SIGNAL.AMBIGUOUS, detail: 'no structured input, deny-by-default' }] };
  }
  const text = typeof input.text === 'string' ? input.text : '';
  const rawPaths = [
    ...(Array.isArray(input.paths) ? input.paths : []),
    input.cwd,
    input.repo,
  ].filter(v => typeof v === 'string' && v.length);

  if (!text && rawPaths.length === 0) {
    return { route: ROUTE.ANTHROPIC_DIRECT, sensitive: true, reasons: [{ signal: SIGNAL.AMBIGUOUS, detail: 'empty request, deny-by-default' }] };
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

  // 4. Private paths, in the referenced paths OR mentioned in the text, unless
  //    an allowlist entry exempts the path. Secret/PII/employer content above is
  //    NEVER exempted by the allowlist.
  const pathBlob = rawPaths.join('\n');
  const allowlisted = anyMatch(config.allowlist, pathBlob);
  const pathHit = anyMatch(config.privatePathPatterns, pathBlob) || anyMatch(config.privatePathPatterns, text);
  if (pathHit && !allowlisted) reasons.push({ signal: SIGNAL.PRIVATE_PATH, detail: `matched ${pathHit.source.slice(0, 48)}` });

  // 5. Infra / secrets operations. Denies for credential-exposure reasons, not
  //    privacy, this work quotes key names and vault layout inline.
  const infraHit = anyMatch(config.infraPatterns || [], text);
  if (infraHit) reasons.push({ signal: SIGNAL.INFRA, detail: `matched ${infraHit.source.slice(0, 48)}` });

  const sensitive = reasons.length > 0;
  return {
    route: sensitive ? ROUTE.ANTHROPIC_DIRECT : ROUTE.AUTO,
    sensitive,
    reasons,
  };
}

/**
 * classifyAsync(input, overrides), convenience wrapper that loads the private
 * config (if present) before classifying. Prefer this at the integration edge;
 * use the sync classify() with a pre-built config in hot paths / tests.
 */
export async function classifyAsync(input, overrides = {}) {
  const pc = await loadPrivateConfig();
  return classify(input, buildConfig(pc, overrides));
}
