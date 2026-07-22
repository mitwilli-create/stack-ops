/**
 * router.test.mjs, tests for the stack-ops router substrate.
 * Run: node --test src/router/router.test.mjs
 *
 * The credential-format tests below are NOT routine coverage. With the privacy
 * gate narrowed to Mitchell's 2026-07-19 ruling, this scanner is the only control
 * standing between a pasted key and a third-party provider. Every format it claims
 * to catch has a test here proving it. Adding a format to SECRET_PATTERNS without
 * adding its test here defeats the point.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classify, classifyAsync, buildConfig, ROUTE, SIGNAL } from './privacy-gate.mjs';
import { triagePr, REVIEWER, REPO_TIER } from './pr-reviewer-triage.mjs';
import { resolveTarget, cursorBaseUrl, ENDPOINTS, OPENROUTER_AUTO_MODEL } from './openrouter-auto.mjs';

// Mitchell-like private config (mirrors private/router-config.mjs shape) so tests
// don't depend on the gitignored file being present. Note what is NOT here any
// more: career-ops and voice-os were removed as private paths per the ruling.
const cfg = buildConfig({
  employerPatterns: [/\bgoogle-internal\b/i, /@google\.com\b/i],
  privatePathPatterns: [/\bclient-nda\b/i],
  allowlist: [/\bstack-ops[\/\\]docs\b/i],
});

// ── the load-bearing credential scanner ──────────────────────────────────────

const CREDENTIAL_FORMATS = {
  'sk- (OpenAI-style)':        'here is my key sk-abcdef0123456789ABCDEF for testing',
  'sk-ant- (Anthropic)':       'ANTHROPIC key sk-ant-api03-BEXZp4pqxmONTHk5st4eitRiUllgDLon',
  'xai-':                      'token xai-abcdef0123456789ABCDEF',
  'AIza (Google)':             'google key AIzaSyD-abcdefghijklmnopqrstuvwxyz01',
  'AQ.Ab (Google OAuth)':      'auth AQ.Ab8RN6JxKqW1vY2zT4pL9mNbXcVdF',
  'ya29. (Google access)':     'bearer ya29.a0AfH6SMBx1234567890abcdefghijklmnop',
  'ghp_ (GitHub)':             'gh token ghp_abcdefghijklmnopqrstuvwxyz0123456789',
  'github_pat_ (fine-grained)':'github_pat_11ABCDEFG0abcdefghijklmnopqrstuv',
  'AKIA (AWS)':                'aws id AKIAIOSFODNN7EXAMPLE',
  'ASIA (AWS temporary)':      'aws sts ASIAIOSFODNN7EXAMPLE',
  'xoxb- (Slack)':             'slack xoxb-1234567890-abcdefghijk',
  'PEM private key block':     '-----BEGIN RSA PRIVATE KEY-----\nMIIEow...',
  'JWT':                       'session eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N',
  'bearer token header':       'Authorization: Bearer abcdef0123456789ABCDEFGH',
  '.env-style KEY=value':      'OPENAI_API_KEY=sk-proj-verylongsecretvalue1234567890',
  'password: assignment':      'password: hunter2-correct-horse-battery',
  'totp/2FA seed':             'totp_secret = JBSWY3DPEHPK3PXPABCDEF',
  // Filed under credentials, not PII, by ruling: a card number is a bearer
  // instrument like an API key, not a fact about his finances.
  'Visa card number':          'card 4111111111111111 exp 04/29',
  'Mastercard number':        'pay with 5555555555554444',
  'Amex number':               'amex 378282246310005',
  // Grouped separators are the dominant real-world card format; without these the
  // scanner under-filtered them straight to the cheap path (verify 2026-07-20).
  'Visa card, space-grouped':  'card 4111 1111 1111 1111 exp 04/29',
  'Visa card, dash-grouped':   'card 4111-1111-1111-1111 exp 04/29',
  'Amex, space-grouped':       'amex 3782 822463 10005',
  // The header is normally uppercase, but a downcase must not evade the scanner.
  'PEM key, lowercased header':'-----begin private key-----\nMIIEow...',
};

for (const [format, sample] of Object.entries(CREDENTIAL_FORMATS)) {
  test(`scanner catches ${format}`, () => {
    const d = classify({ text: sample }, cfg);
    assert.equal(d.route, ROUTE.ANTHROPIC_DIRECT, `${format} leaked to the cheap path`);
    assert.ok(d.reasons.some(r => r.signal === SIGNAL.SECRET), `${format} did not fire the SECRET signal`);
  });
}

test('scanner is full-content, not sampled: a key buried in a long body is caught', () => {
  const filler = 'lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(400);
  const d = classify({ text: `${filler}\nAKIAIOSFODNN7EXAMPLE\n${filler}` }, cfg);
  assert.equal(d.route, ROUTE.ANTHROPIC_DIRECT);
  assert.ok(d.reasons.some(r => r.signal === SIGNAL.SECRET));
});

// ── what the ruling says must route CHEAP (regression guard) ─────────────────
// These are the categories Mitchell explicitly ruled ALLOW after a risk review.
// A failure here means the gate has silently widened and is costing him money.

const MUST_ROUTE_CHEAP = {
  // NOTE: these samples run against the SYNTHETIC cfg below, so the literal
  // values are illustrative, not load-bearing, keep them obviously fake. The
  // owner-specific patterns live in the gitignored private overlay, and the
  // tests that exercise it are the classifyAsync ones further down.
  'email address':            'ping me at owner@example.com about the draft',
  'phone number':             'call 206-555-0142 when the interview is confirmed',
  'home address':             'ship it to 1 Example Street, Springfield IL 62701',
  'current employer':         'my current employer is Google and I was laid off in July',
  'layoff status':            'last day is Aug 23 2026, garden leave until then',
  'relocation plans':         'relocating to Spain after Nov 30 2026, need the visa timeline',
  'health information':       'the insurance deadline matters because of my health coverage',
  'financial details':        'severance is roughly 14 weeks of base salary',
  'ID document mention':      'I need my passport and drivers licence for the visa appointment',
  'unpublished career work':  'here is my unsent cover letter and salary negotiation notes',
  'third-party data':         'candid note on the hiring manager: seemed lukewarm on comms hires',
  'career-ops path':          'refactor the queue in career-ops/lib/queue.mjs',
  'voice-os corpus path':     'summarize chunks in voice-os/data/corpus/part-004.jsonl',
  '~/.claude memory path':    'update ~/.claude/CLAUDE.md with the routing doctrine',
  'session transcript':       'read the session transcript and pull out the decisions',
};

for (const [category, sample] of Object.entries(MUST_ROUTE_CHEAP)) {
  test(`ruled-ALLOW routes cheap: ${category}`, () => {
    const d = classify({ text: sample }, cfg);
    assert.equal(d.route, ROUTE.AUTO,
      `${category} was gated to Anthropic, the gate has widened past the ruling. Reasons: ${JSON.stringify(d.reasons)}`);
  });
}

// ── the narrow triggers that DO still fire ───────────────────────────────────

test('gate: generic code request → auto (cheap)', () => {
  const d = classify({ text: 'Refactor this loop into a map and add a unit test.', paths: ['src/util.js'] }, cfg);
  assert.equal(d.route, ROUTE.AUTO);
  assert.equal(d.sensitive, false);
});

test('gate: SSN → anthropic-direct', () => {
  const d = classify({ text: 'SSN 123-45-6789' }, cfg);
  assert.equal(d.route, ROUTE.ANTHROPIC_DIRECT);
  assert.ok(d.reasons.some(r => r.signal === SIGNAL.PII));
});

test('gate: dotted SSN is gated; space-separated is deliberately NOT', () => {
  // Dotted variant under-filtered before 2026-07-20 and is now caught. Space
  // separator was rejected: "123 45 6789"-shaped runs are common in SKUs/invoices,
  // so matching them over-filters ordinary work to the expensive path with no real
  // leak-risk gain (canonical SSN is dash-delimited).
  assert.equal(classify({ text: 'SSN 123.45.6789' }, cfg).route, ROUTE.ANTHROPIC_DIRECT);
  assert.equal(classify({ text: 'invoice 123 45 6789 total' }, cfg).route, ROUTE.AUTO);
});

test('gate: passport NUMBER is gated, but the word alone is not', () => {
  assert.equal(classify({ text: 'passport number: X1234567' }, cfg).route, ROUTE.ANTHROPIC_DIRECT);
  assert.equal(classify({ text: 'bring your passport to the appointment' }, cfg).route, ROUTE.AUTO);
});

test('gate: credential-holding paths → anthropic-direct', () => {
  assert.equal(classify({ text: 'open ~/.secrets/api-keys.env' }, cfg).route, ROUTE.ANTHROPIC_DIRECT);
  assert.equal(classify({ text: 'edit it', paths: ['/Users/m/.ssh/id_ed25519'] }, cfg).route, ROUTE.ANTHROPIC_DIRECT);
  assert.equal(classify({ text: 'fix the shell rc', paths: ['/Users/m/.zshenv'] }, cfg).route, ROUTE.ANTHROPIC_DIRECT);
});

// Uses the REAL private config, not the synthetic one, the 2026-07-19 session
// shipped a gate whose unit tests passed while the live overlay still gated
// everything, because the tests never loaded the overlay. These two do.
test('gate: the Severance directory is gated (legal/privileged, by ruling)', async () => {
  // The overlay's trigger is anchored on `Documents/Severance` specifically, so
  // the username and any subfolder are irrelevant to what this asserts, keep
  // real client engagement names OUT of a repo intended to go public.
  const d = await classifyAsync({ text: 'summarize this', paths: ['/Users/example/Documents/Severance/notes.md'] });
  assert.equal(d.route, ROUTE.ANTHROPIC_DIRECT);
  assert.ok(d.reasons.some(r => r.signal === SIGNAL.PRIVATE_PATH));
});

test('gate: the WORD "severance" still routes cheap, only the directory is gated', async () => {
  const d = await classifyAsync({ text: 'my severance is about 14 weeks of base salary, help me plan the runway' });
  assert.equal(d.route, ROUTE.AUTO,
    'a bare /severance/ pattern would re-gate financial details, which are ruled cheap');
});

test('gate: paths ruled OUT of the NDA trigger route cheap', async () => {
  // Directory NAMES stay real, they are the regression guard, and a future
  // re-add of an `upwork` or `Client_Projects` pattern must fail here. Only the
  // username is genericized.
  for (const p of ['/Users/example/Documents/upwork-demos/demo1/index.mjs',
                   '/Users/example/Downloads/01_Active_Projects/Client_Projects/x.md']) {
    assert.equal((await classifyAsync({ text: 'tidy this up', paths: [p] })).route, ROUTE.AUTO, `${p} should route cheap`);
  }
});

test('gate: employer-proprietary marker → anthropic-direct', () => {
  const d = classify({ text: 'port the google-internal service shim' }, cfg);
  assert.equal(d.route, ROUTE.ANTHROPIC_DIRECT);
  assert.ok(d.reasons.some(r => r.signal === SIGNAL.EMPLOYER));
});

test('gate: infra/secrets operations → anthropic-direct (credential exposure)', () => {
  const d = classify({ text: 'walk me through how to rotate the API key in the vault' }, cfg);
  assert.equal(d.route, ROUTE.ANTHROPIC_DIRECT);
  assert.ok(d.reasons.some(r => r.signal === SIGNAL.INFRA));
});

test('gate: allowlist exempts a public path but NEVER exempts a secret', () => {
  assert.equal(classify({ text: 'edit the doc', paths: ['stack-ops/docs/x.md'] }, cfg).route, ROUTE.AUTO);
  const d = classify({ text: 'key sk-abcdef0123456789ABCDEF', paths: ['stack-ops/docs/x.md'] }, cfg);
  assert.equal(d.route, ROUTE.ANTHROPIC_DIRECT, 'allowlist must never exempt a credential');
});

test('gate: deny-by-default on empty/malformed input', () => {
  assert.equal(classify(null, cfg).route, ROUTE.ANTHROPIC_DIRECT);
  assert.equal(classify({}, cfg).route, ROUTE.ANTHROPIC_DIRECT);
  assert.equal(classify({ text: '' }, cfg).route, ROUTE.ANTHROPIC_DIRECT);
});

// ── forwarding targets ───────────────────────────────────────────────────────

test('resolveTarget: cheap route → OpenRouter Auto', () => {
  const t = resolveTarget({ route: ROUTE.AUTO });
  assert.equal(t.provider, 'openrouter');
  assert.equal(t.model, OPENROUTER_AUTO_MODEL);
  assert.equal(t.thirdParty, true);
});

test('resolveTarget: agent mode uses the Cursor endpoint', () => {
  assert.equal(resolveTarget({ route: ROUTE.AUTO }, { agentMode: true }).baseUrl, ENDPOINTS.OPENROUTER_CURSOR);
});

test('resolveTarget: sensitive route → Anthropic-direct, never third party', () => {
  const t = resolveTarget({ route: ROUTE.ANTHROPIC_DIRECT });
  assert.equal(t.provider, 'anthropic');
  assert.equal(t.thirdParty, false);
});

test('resolveTarget: unrecognized route defaults to the trusted provider', () => {
  const t = resolveTarget({ route: 'nonsense' });
  assert.equal(t.provider, 'anthropic');
  assert.equal(t.thirdParty, false);
  assert.match(t.note, /deny-by-default/);
});

test('cursorBaseUrl: refuses localhost / private hosts (Cursor SSRF-blocks them)', () => {
  assert.throws(() => cursorBaseUrl('http://127.0.0.1:8787'), /refusing localhost/);
  assert.throws(() => cursorBaseUrl('http://localhost:8787'), /refusing localhost/);
  assert.equal(cursorBaseUrl('https://router.example.ts.net'), 'https://router.example.ts.net/v1');
  assert.equal(cursorBaseUrl('https://router.example.ts.net', { agentMode: true }), 'https://router.example.ts.net/v1/cursor');
});

// ── PR reviewer triage ───────────────────────────────────────────────────────

test('triagePr: small low-risk diff → CodeRabbit only', () => {
  const r = triagePr({ additions: 20, deletions: 5, filesChanged: 2, repoTier: REPO_TIER.STANDARD });
  assert.ok(r.reviewers.includes(REVIEWER.CODERABBIT));
  assert.ok(r.reviewers.length <= 2, 'never stack three bots on one PR');
});

test('triagePr: never assigns three reviewers to one PR', () => {
  const r = triagePr({ additions: 5000, deletions: 3000, filesChanged: 90, repoTier: REPO_TIER.PRODUCTION_CRITICAL, riskLabels: ['security', 'migration'] });
  assert.ok(r.reviewers.length <= 2, `got ${r.reviewers.length} reviewers`);
});

// ─────────────────────────────────────────────────────────────────────────────
// Path-context narrowing, ruled 2026-07-22. These tests exist because the gate
// was measured refusing 33% of this repo's own public docs. Each PASS case below
// is a real string from a real file that was really refused before the change,
// so these can go red: revert the narrowing and the four PASS cases fail.
// ─────────────────────────────────────────────────────────────────────────────

test('gate: the WORD "credentials" in prose routes cheap (was a false block)', () => {
  const r = classify({ text: 'The MCP layer never stores credentials in the config file.' }, cfg);
  assert.equal(r.route, ROUTE.AUTO, JSON.stringify(r.reasons));
});

test('gate: a FILE named credentials is still gated', () => {
  const r = classify({ text: 'x', paths: ['~/.aws/credentials'] }, cfg);
  assert.equal(r.route, ROUTE.ANTHROPIC_DIRECT);
  assert.equal(r.reasons[0].signal, SIGNAL.PRIVATE_PATH);
});

// RESIDUAL OVER-FILTER, known and accepted 2026-07-22. Path-context narrowing
// cannot separate "documenting a path" from "pasting a path": both produce the
// identical token. So a doc that spells out ~/.secrets/api-keys.env still gates,
// and docs/memory-mem0.md in this repo is still refused. Closing this would mean
// applying path patterns to the paths array ONLY (the stronger option Mitchell
// considered and did not pick), which would also stop catching a genuinely
// pasted private path. Asserting the real behavior, not the desired one: a test
// that lied here would be exactly the green-check-that-cannot-go-red this repo
// bans. Revisit only with a new ruling.
test('gate: a spelled-out private path in a doc still gates (known residual)', () => {
  const r = classify({ text: 'Add `MEM0_API_KEY` to `~/.secrets/api-keys.env` (value-blind).' }, cfg);
  assert.equal(r.route, ROUTE.ANTHROPIC_DIRECT);
  assert.equal(r.reasons[0].signal, SIGNAL.PRIVATE_PATH);
});

test('gate: a PASTED private path in text is still gated', () => {
  const r = classify({ text: 'cat ~/.secrets/api-keys.env and tell me what is wrong' }, cfg);
  assert.equal(r.route, ROUTE.ANTHROPIC_DIRECT);
});

test('gate: DESCRIBING a secret-scan gate routes cheap (was a false block)', () => {
  const r = classify({ text: 'See private/HANDOVER.md for the public-repo publishing gate and its secret-scan step.' }, cfg);
  assert.equal(r.route, ROUTE.AUTO, JSON.stringify(r.reasons));
});

test('gate: PERFORMING a secret scan is still gated', () => {
  const r = classify({ text: 'run a secret-scan across the full tree before we push' }, cfg);
  assert.equal(r.route, ROUTE.ANTHROPIC_DIRECT);
  assert.equal(r.reasons[0].signal, SIGNAL.INFRA);
});

test('gate: narrowing did NOT weaken the credential scanner', () => {
  // The whole safety argument for the narrowing is that signal 1 still catches a
  // real key even in a doc the path signal now lets through. Prove it.
  const r = classify({ text: 'Add MEM0_API_KEY to ~/.secrets/api-keys.env, the value is sk-proj-AAAABBBBCCCCDDDDEEEE1234' }, cfg);
  assert.equal(r.route, ROUTE.ANTHROPIC_DIRECT);
  assert.equal(r.reasons[0].signal, SIGNAL.SECRET);
});

// ─────────────────────────────────────────────────────────────────────────────
// CodeRabbit review round 1, PR #3 (2026-07-22). Every case below is a real
// finding from that review, not hypothetical coverage.
// ─────────────────────────────────────────────────────────────────────────────

test('gate: Windows-separator private path is caught (was a bypass)', () => {
  // Backslash tokens were collected but never normalized, while the patterns
  // anchor on `/`. So this routed externally. Found by review, not by the corpus:
  // every planted case used POSIX paths.
  // Isolating the behavior under test took three attempts, which is the point of
  // the can-fail rule. `id_rsa` matches a bare-filename pattern; `api-keys.env`
  // matches a separator-independent one. Both passed with the normalizer DELETED,
  // i.e. green for the wrong reason. `.ssh\\config` matches only via the
  // `(?:^|\/)\.ssh(?:\/|$)` anchor, so it goes red without normalization.
  const r = classify({ text: 'open C:\\Users\\me\\.ssh\\config and check it' }, cfg);
  assert.equal(r.route, ROUTE.ANTHROPIC_DIRECT);
});

test('gate: Windows-separator path in the paths ARRAY is caught too', () => {
  const r = classify({ text: 'x', paths: ['C:\\Users\\me\\.aws\\credentials'] }, cfg);
  assert.equal(r.route, ROUTE.ANTHROPIC_DIRECT);
  assert.equal(r.reasons[0].signal, SIGNAL.PRIVATE_PATH);
});

test('gate: DESCRIBING a secrets rotation policy routes cheap', () => {
  // The action-verb rule was applied to secret-scan but not to
  // rotation/hardening, so this still blocked, contradicting the narrowing.
  const r = classify({ text: 'Our secrets rotation policy is documented in the handbook.' }, cfg);
  assert.equal(r.route, ROUTE.AUTO, JSON.stringify(r.reasons));
});

test('gate: PERFORMING a secrets rotation is still gated', () => {
  const r = classify({ text: 'run the secrets rotation for the council server now' }, cfg);
  assert.equal(r.route, ROUTE.ANTHROPIC_DIRECT);
  assert.equal(r.reasons[0].signal, SIGNAL.INFRA);
});

// ── CodeRabbit round 2, PR #3 (2026-07-22) ──────────────────────────────────

test('gate: an allowlisted path does NOT exempt a private path beside it', () => {
  // The severe direction. Before the per-candidate fix this returned AUTO with an
  // EMPTY reasons array: a credential path left the machine and the decision
  // looked clean in the log.
  const r = classify({ text: 'summarize these', paths: ['stack-ops/docs/x.md', '~/.aws/credentials'] }, cfg);
  assert.equal(r.route, ROUTE.ANTHROPIC_DIRECT, `leaked: ${JSON.stringify(r.reasons)}`);
  assert.equal(r.reasons[0].signal, SIGNAL.PRIVATE_PATH);
});

test('gate: an allowlisted path alone still routes cheap', () => {
  // Guard the other direction, so the fix above is a narrowing of the exemption
  // and not a removal of it.
  const r = classify({ text: 'summarize this', paths: ['stack-ops/docs/x.md'] }, cfg);
  assert.equal(r.route, ROUTE.AUTO, JSON.stringify(r.reasons));
});

test('gate: the allowlist now applies to paths found in TEXT too', () => {
  // Mirror-image defect: text-extracted paths were never allowlist-checked, so an
  // allowlisted path mentioned in prose could never be exempted.
  const r = classify({ text: 'check stack-ops/docs/mcp-layer.md for the wording' }, cfg);
  assert.equal(r.route, ROUTE.AUTO, JSON.stringify(r.reasons));
});
