import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const plannerModule = await import('./subscription-plan-fallback.mjs').catch(() => ({}));

function executable(path, body) {
  writeFileSync(path, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(path, 0o700);
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'subscription-plan-fallback-'));
  const workDir = join(dir, 'source');
  const runDir = join(dir, 'receipts');
  const claudeBin = join(dir, 'claude-fake.mjs');
  const codexBin = join(dir, 'codex-fake.mjs');
  const scannerScript = join(dir, 'scanner-fake.mjs');
  const capture = join(dir, 'capture.json');
  mkdirSync(workDir);
  mkdirSync(runDir);
  writeFileSync(join(dir, '.keep'), 'fixture');
  executable(scannerScript, `
    const { readFileSync, statSync } = await import('node:fs');
    if ((statSync(process.argv[2]).mode & 0o777) !== 0o600) process.exit(3);
    const text = readFileSync(process.argv[2], 'utf8');
    process.exit(text.includes('BLOCKED_VALUE') ? 2 : 0);
  `);
  return {
    dir,
    workDir,
    runDir,
    claudeBin,
    codexBin,
    scannerScript,
    capture,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function options(f, overrides = {}) {
  return {
    prompt: 'Return one typed maintenance plan.',
    workDir: f.workDir,
    runDir: f.runDir,
    timeoutMs: 10_000,
    scanner: { bin: process.execPath, script: f.scannerScript },
    claude: { bin: f.claudeBin, model: 'sonnet' },
    codex: { bin: f.codexBin, model: 'gpt-test' },
    ...overrides,
  };
}

function claudeFailure(f, message) {
  executable(f.claudeBin, `
    process.stderr.write(${JSON.stringify(`${message}\n`)});
    process.exit(1);
  `);
}

function codexProvider(f, { login = 'Logged in using ChatGPT', plan = { operations: [] } } = {}) {
  executable(f.codexBin, `
    const { mkdirSync, readFileSync, statSync, writeFileSync } = await import('node:fs');
    const args = process.argv.slice(2);
    if (args[0] === 'login') {
      process.stdout.write(${JSON.stringify(`${login}\n`)});
      process.exit(0);
    }
    const sourceDir = args[args.indexOf('-C') + 1];
    process.chdir(sourceDir);
    const outputPath = args[args.indexOf('-o') + 1];
    mkdirSync(new URL('.', 'file://' + outputPath).pathname, { recursive: true });
    const outputModeBeforeWrite = statSync(outputPath).mode & 0o777;
    const dangerousEnvironmentNames = [
      'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
      'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'XAI_API_KEY', 'OPENROUTER_API_KEY',
      'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
      'AWS_ACCESS_KEY_ID', 'GOOGLE_APPLICATION_CREDENTIALS', 'AZURE_OPENAI_API_KEY',
    ].filter((key) => Object.hasOwn(process.env, key));
    let source = null;
    try { source = readFileSync('source.md', 'utf8'); } catch { /* recorded as null */ }
    writeFileSync(${JSON.stringify(f.capture)}, JSON.stringify({
      args,
      cwd: process.cwd(),
      source,
      outputModeBeforeWrite,
      dangerousEnvironmentNames,
    }));
    writeFileSync(outputPath, ${JSON.stringify(JSON.stringify(plan))});
    process.stdout.write('completed\\n');
  `);
}

test('classifies a weekly limit even when a long provider envelope precedes the reason', () => {
  assert.equal(typeof plannerModule.classifyPlannerFailure, 'function', 'failure classifier is not implemented');
  const text = JSON.stringify({
    metadata: 'x'.repeat(800),
    api_error_status: 429,
    result: "You've hit your weekly limit; resets later",
  });
  assert.equal(plannerModule.classifyPlannerFailure({ text }), 'plan_limit');
});

test('a weekly limit advances to a proven ChatGPT subscription with source grounding and a scrubbed environment', () => {
  assert.equal(typeof plannerModule.runSubscriptionPlan, 'function', 'subscription plan runner is not implemented');
  const f = fixture();
  const seeded = [
    'ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK',
    'AWS_ACCESS_KEY_ID', 'GOOGLE_APPLICATION_CREDENTIALS',
  ];
  const previous = new Map(seeded.map((key) => [key, process.env[key]]));
  try {
    writeFileSync(join(f.workDir, 'source.md'), 'grounded source');
    claudeFailure(f, "You've hit your weekly limit; resets later");
    codexProvider(f);
    for (const key of seeded) process.env[key] = 'test-only-routing-value';

    const result = plannerModule.runSubscriptionPlan(options(f));

    assert.equal(result.ok, true);
    assert.deepEqual(result.plan, { operations: [] });
    assert.deepEqual(result.attempts.map((attempt) => [attempt.provider, attempt.status, attempt.failureReason]), [
      ['claude-cli', 'failed', 'plan_limit'],
      ['codex-cli', 'succeeded', null],
    ]);
    const captured = JSON.parse(readFileSync(f.capture, 'utf8'));
    assert.equal(captured.cwd, realpathSync(f.workDir));
    assert.equal(captured.source, 'grounded source');
    assert.equal(captured.outputModeBeforeWrite, 0o600);
    assert.deepEqual(captured.dangerousEnvironmentNames, []);
    assert.ok(captured.args.includes('--ephemeral'));
    assert.ok(captured.args.includes('--ignore-user-config'));
    assert.deepEqual(captured.args.slice(captured.args.indexOf('--sandbox'), captured.args.indexOf('--sandbox') + 2), ['--sandbox', 'read-only']);
    assert.equal(captured.args[captured.args.indexOf('-C') + 1], f.workDir);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    f.cleanup();
  }
});

test('a credential-bearing prompt may stay with Claude but never crosses to Codex', () => {
  const f = fixture();
  try {
    executable(f.claudeBin, `writeFileSync(${JSON.stringify(f.capture)}, 'claude');`.replace('writeFileSync', `(await import('node:fs')).writeFileSync`));
    codexProvider(f);
    const result = plannerModule.runSubscriptionPlan(options(f, { prompt: 'contains BLOCKED_VALUE' }));
    assert.equal(result.ok, false);
    assert.equal(result.failureReason, 'privacy');
    assert.equal(readFileSync(f.capture, 'utf8'), 'claude');
    assert.deepEqual(result.attempts.map((attempt) => [attempt.provider, attempt.failureReason]), [
      ['claude-cli', 'malformed_response'],
    ]);
  } finally { f.cleanup(); }
});

test('an unsafe complete plan is rejected before it can be returned or persisted', () => {
  const f = fixture();
  try {
    claudeFailure(f, 'HTTP 429 quota exhausted');
    codexProvider(f, { plan: { operations: [{ op: 'supersede', why: 'BLOCKED_VALUE' }] } });
    const result = plannerModule.runSubscriptionPlan(options(f));
    assert.equal(result.ok, false);
    assert.equal(result.failureReason, 'privacy');
    assert.equal(result.plan, undefined);
    assert.deepEqual(result.attempts.map((attempt) => attempt.failureReason), ['rate_quota', 'privacy']);
  } finally { f.cleanup(); }
});

test('HTTP 403 hard-stops as authorization while HTTP 401 may advance as a credential failure', () => {
  const blocked = fixture();
  try {
    claudeFailure(blocked, 'HTTP 403 forbidden: access denied');
    codexProvider(blocked);
    const result = plannerModule.runSubscriptionPlan(options(blocked));
    assert.equal(result.failureReason, 'authorization');
    assert.equal(existsSync(blocked.capture), false);
  } finally { blocked.cleanup(); }

  const retryable = fixture();
  try {
    claudeFailure(retryable, 'HTTP 401 unauthorized: login required');
    codexProvider(retryable);
    const result = plannerModule.runSubscriptionPlan(options(retryable));
    assert.equal(result.ok, true);
    assert.deepEqual(result.attempts.map((attempt) => attempt.failureReason), ['credential', null]);
  } finally { retryable.cleanup(); }
});

test('Codex API-key login is rejected before execution and never labeled subscription', () => {
  const f = fixture();
  try {
    claudeFailure(f, 'weekly limit');
    codexProvider(f, { login: 'Logged in using an API key' });
    const result = plannerModule.runSubscriptionPlan(options(f));
    assert.equal(result.ok, false);
    assert.equal(result.failureReason, 'account_unverified');
    assert.equal(existsSync(f.capture), false);
    assert.deepEqual(result.attempts.map((attempt) => attempt.failureReason), ['plan_limit', 'account_unverified']);
  } finally { f.cleanup(); }
});

test('missing executables are unavailable and a hanging provider is a timeout', () => {
  const missing = fixture();
  try {
    const result = plannerModule.runSubscriptionPlan(options(missing, {
      claude: { bin: join(missing.dir, 'absent'), model: 'sonnet' },
      codex: null,
    }));
    assert.equal(result.failureReason, 'unavailable');
  } finally { missing.cleanup(); }

  const hanging = fixture();
  try {
    executable(hanging.claudeBin, `setInterval(() => {}, 1_000);`);
    const result = plannerModule.runSubscriptionPlan(options(hanging, {
      timeoutMs: 100,
      codex: null,
    }));
    assert.equal(result.failureReason, 'timeout');
  } finally { hanging.cleanup(); }
});

test('preflight-skipped providers remain in the bounded attempt receipt', () => {
  const f = fixture();
  try {
    codexProvider(f);
    const preflightAttempt = {
      requestedSlot: 'frontier-planner',
      resolvedModel: 'sonnet',
      provider: 'claude-cli',
      accountType: 'subscription',
      status: 'skipped',
      failureReason: 'credential',
    };
    const result = plannerModule.runSubscriptionPlan(options(f, {
      claude: null,
      preflightAttempts: [preflightAttempt],
    }));
    assert.equal(result.ok, true);
    assert.deepEqual(result.attempts[0], preflightAttempt);
  } finally { f.cleanup(); }
});
