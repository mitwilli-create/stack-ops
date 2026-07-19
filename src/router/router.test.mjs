/**
 * router.test.mjs — tests for the stack-ops router substrate.
 * Run: node --test src/router/router.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classify, buildConfig, ROUTE, SIGNAL } from './privacy-gate.mjs';
import { triagePr, REVIEWER, REPO_TIER } from './pr-reviewer-triage.mjs';
import { resolveTarget, cursorBaseUrl, ENDPOINTS, OPENROUTER_AUTO_MODEL } from './openrouter-auto.mjs';

// Mitchell-like private config (mirrors private/router-config.mjs shape) so tests
// don't depend on the gitignored file being present.
const cfg = buildConfig({
  privatePathPatterns: [/\bcareer-ops\b/i, /\bvoice-os\b/i],
  employerPatterns: [/\bgoogle-internal\b/i, /@google\.com\b/i],
  piiPatterns: [/\buser@example\.com\b/i],
  allowlist: [/\bstack-ops[\/\\]docs\b/i],
});

// ── privacy gate ─────────────────────────────────────────────────────────────

test('gate: generic code request → auto (cheap)', () => {
  const d = classify({ text: 'Refactor this loop into a map and add a unit test.', paths: ['src/util.js'] }, cfg);
  assert.equal(d.route, ROUTE.AUTO);
  assert.equal(d.sensitive, false);
});

test('gate: request containing a secret → anthropic-direct', () => {
  const d = classify({ text: 'here is my key sk-abcdef0123456789ABCDEF for testing' }, cfg);
  assert.equal(d.route, ROUTE.ANTHROPIC_DIRECT);
  assert.ok(d.reasons.some(r => r.signal === SIGNAL.SECRET));
});

test('gate: ENV=value secret assignment → anthropic-direct', () => {
  const d = classify({ text: 'OPENAI_API_KEY=sk-proj-verylongsecretvalue1234567890' }, cfg);
  assert.equal(d.route, ROUTE.ANTHROPIC_DIRECT);
});

test('gate: PII (email + SSN) → anthropic-direct', () => {
  assert.equal(classify({ text: 'contact user@example.com' }, cfg).route, ROUTE.ANTHROPIC_DIRECT);
  assert.equal(classify({ text: 'SSN 123-45-6789' }, cfg).route, ROUTE.ANTHROPIC_DIRECT);
});

test('gate: private path (career-ops / .secrets) → anthropic-direct', () => {
  assert.equal(classify({ text: 'edit lib/x', paths: ['/Users/m/Documents/career-ops/lib/x.mjs'] }, cfg).route, ROUTE.ANTHROPIC_DIRECT);
  assert.equal(classify({ text: 'open ~/.secrets/api-keys.env' }, cfg).route, ROUTE.ANTHROPIC_DIRECT);
});

test('gate: employer-proprietary marker → anthropic-direct', () => {
  const d = classify({ text: 'port this from the google-internal build' }, cfg);
  assert.equal(d.route, ROUTE.ANTHROPIC_DIRECT);
  assert.ok(d.reasons.some(r => r.signal === SIGNAL.EMPLOYER));
});

test('gate: allowlisted public docs path inside a private repo → auto', () => {
  const d = classify({ text: 'update the public stack map', paths: ['/Users/m/Documents/stack-ops/docs/stack-map.md'] }, cfg);
  assert.equal(d.route, ROUTE.AUTO);
});

test('gate: allowlist NEVER exempts secret content', () => {
  const d = classify({ text: 'token sk-abcdef0123456789ABCDEF', paths: ['/Users/m/Documents/stack-ops/docs/x.md'] }, cfg);
  assert.equal(d.route, ROUTE.ANTHROPIC_DIRECT); // secret wins over allowlisted path
});

test('gate: empty / malformed input → deny-by-default', () => {
  assert.equal(classify({}, cfg).route, ROUTE.ANTHROPIC_DIRECT);
  assert.equal(classify(null, cfg).route, ROUTE.ANTHROPIC_DIRECT);
  assert.equal(classify({ text: '' }, cfg).route, ROUTE.ANTHROPIC_DIRECT);
});

test('gate: works with generic defaults (no private config)', () => {
  const d = classify({ text: 'open ~/.ssh/id_rsa' }); // buildConfig() default
  assert.equal(d.route, ROUTE.ANTHROPIC_DIRECT);
});

// ── PR reviewer triage ───────────────────────────────────────────────────────

test('triage: small standard PR → CodeRabbit only', () => {
  const r = triagePr({ repoTier: REPO_TIER.STANDARD, filesChanged: 2, linesChanged: 30 });
  assert.deepEqual(r.reviewers, [REVIEWER.CODERABBIT]);
  assert.equal(r.mergeGate, null);
});

test('triage: complex repo → CodeRabbit + Greptile', () => {
  const r = triagePr({ repoTier: REPO_TIER.COMPLEX, filesChanged: 3, linesChanged: 50 });
  assert.ok(r.reviewers.includes(REVIEWER.CODERABBIT));
  assert.ok(r.reviewers.includes(REVIEWER.GREPTILE));
  assert.ok(!r.reviewers.includes(REVIEWER.QODO));
});

test('triage: large diff on a standard repo pulls in Greptile', () => {
  const r = triagePr({ repoTier: REPO_TIER.STANDARD, filesChanged: 20, linesChanged: 900 });
  assert.ok(r.reviewers.includes(REVIEWER.GREPTILE));
});

test('triage: production + high-stakes → adds Qodo merge-gate', () => {
  const r = triagePr({ repoTier: REPO_TIER.PRODUCTION, filesChanged: 8, linesChanged: 300, riskLabels: ['security'] });
  assert.ok(r.reviewers.includes(REVIEWER.QODO));
  assert.equal(r.mergeGate, REVIEWER.QODO);
});

test('triage: production but trivial low-risk PR does NOT get 3 bots', () => {
  const r = triagePr({ repoTier: REPO_TIER.PRODUCTION, filesChanged: 1, linesChanged: 5 });
  // production → Greptile added, but no high-stakes → no Qodo; and never 3 bots here
  assert.ok(!r.reviewers.includes(REVIEWER.QODO) || r.reviewers.length < 3);
});

// ── openrouter auto target resolution ────────────────────────────────────────

test('resolveTarget: auto route → OpenRouter Auto (standard endpoint)', () => {
  const t = resolveTarget({ route: ROUTE.AUTO });
  assert.equal(t.provider, 'openrouter');
  assert.equal(t.model, OPENROUTER_AUTO_MODEL);
  assert.equal(t.baseUrl, ENDPOINTS.OPENROUTER_STANDARD);
  assert.equal(t.thirdParty, true);
});

test('resolveTarget: auto route + agentMode → /cursor endpoint', () => {
  const t = resolveTarget({ route: ROUTE.AUTO }, { agentMode: true });
  assert.equal(t.baseUrl, ENDPOINTS.OPENROUTER_CURSOR);
});

test('resolveTarget: sensitive route → Anthropic-direct (no third party)', () => {
  const t = resolveTarget({ route: ROUTE.ANTHROPIC_DIRECT });
  assert.equal(t.provider, 'anthropic');
  assert.equal(t.thirdParty, false);
});

test('resolveTarget: unknown route → defaults to trusted (deny-by-default)', () => {
  const t = resolveTarget({ route: 'garbage' });
  assert.equal(t.thirdParty, false);
  assert.ok(t.note);
});

test('cursorBaseUrl: rejects localhost (Cursor SSRF)', () => {
  assert.throws(() => cursorBaseUrl('http://127.0.0.1:8080'));
  assert.throws(() => cursorBaseUrl('http://localhost:8080'));
});

test('cursorBaseUrl: accepts a MagicDNS host, appends the right suffix', () => {
  assert.equal(cursorBaseUrl('https://router.tail1234.ts.net'), 'https://router.tail1234.ts.net/v1');
  assert.equal(cursorBaseUrl('https://router.tail1234.ts.net/', { agentMode: true }), 'https://router.tail1234.ts.net/v1/cursor');
});
