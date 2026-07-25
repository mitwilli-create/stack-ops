/**
 * cheap.test.mjs: integration coverage for the cheap-dispatch CLI's timeout.
 * Run: node --test src/router/cheap.test.mjs
 *
 * cheap.mjs is a top-level script, not a module, so these spawn it as a subprocess.
 * The load-bearing case is the timeout: before the AbortSignal bound was added
 * (2026-07-20) a stuck upstream hung the caller forever, which is a large part of
 * why no real traffic trusted the cheap path. This plants a server that accepts the
 * connection and never replies, then proves the CLI aborts within the bound AND
 * records the timeout in its decision log. Remove the signal and this test hangs
 * until node:test kills it, proving it can actually go red.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { readFileSync, rmSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), 'cheap.mjs');

// Read a spawned child to completion: exit code plus captured stdout/stderr.
function runCli(extraArgs, env) {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI, ...extraArgs], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

const readLog = (p) => readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

// Accept the TCP connection, then hold the socket open and write nothing, so the
// caller reaches the response-wait state and only the timeout can end it.
function blackHole() {
  return new Promise((resolve) => {
    const server = createServer(() => { /* never respond */ });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('cheap: a non-responding upstream aborts within the timeout and is logged', async () => {
  const server = await blackHole();
  const { port } = server.address();
  const logPath = join(tmpdir(), `cheap-timeout-test-${port}.jsonl`);
  try {
    const started = Date.now();
    // Must be TAGGED now: an untagged call refuses before it ever reaches an upstream
    // (see the untagged-refusal test below), so it would never exercise the timeout.
    // log_triage is a two-rung ladder, so both rungs hit the black hole and time out.
    const child = spawn('node', [CLI, '--task', 'log_triage', 'summarize the following bulk material for a test run'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CHEAP_OPENROUTER_URL: `http://127.0.0.1:${port}`,
        OPENROUTER_API_KEY: 'sk-fake-test-key-not-real',
        CHEAP_TIMEOUT_MS: '800',
        CHEAP_DECISION_LOG: logPath,
      },
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    const code = await new Promise((resolve) => child.on('exit', resolve));
    const elapsed = Date.now() - started;

    assert.equal(code, 7, `expected timeout exit code 7, got ${code}. stderr: ${stderr}`);
    assert.ok(elapsed < 8000, `CLI should abort well under 8s; took ${elapsed}ms (still hanging?)`);
    assert.match(stderr, /did not respond within/, 'stderr should explain the timeout');
    const rows = readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.ok(rows.some((r) => r.outcome === 'timeout'), 'the timeout must be recorded in the decision log');
  } finally {
    server.close();
    try { rmSync(logPath, { force: true }); } catch { /* best-effort cleanup */ }
  }
});

// FIX 1: an untagged call (no --task, no --model) must NOT silently fall through to a
// catch-all that OpenRouter Auto can land on a frontier model. It refuses BEFORE any
// upstream call, mirroring the privacy-gate refusal (non-zero exit + a decision-log
// row). Remove the guard in cheap.mjs and this goes red: the call would route out.
test('cheap: an untagged call refuses before calling any upstream, and is logged', async () => {
  const logPath = join(tmpdir(), `cheap-untagged-test-${process.pid}.jsonl`);
  try {
    const { code, stderr } = await runCli(
      ['summarize the following bulk material for a test run of untagged routing'],
      {
        // Point the URL somewhere that would fail loudly if it were ever hit: the
        // whole point is that it is NOT hit.
        CHEAP_OPENROUTER_URL: 'http://127.0.0.1:1/never',
        OPENROUTER_API_KEY: 'sk-fake-test-key-not-real',
        CHEAP_DECISION_LOG: logPath,
      },
    );
    assert.equal(code, 8, `expected untagged-refusal exit code 8, got ${code}. stderr: ${stderr}`);
    assert.match(stderr, /REFUSED/, 'stderr should announce the refusal');
    assert.match(stderr, /--task/, 'stderr should tell the user to pass --task (or --model)');
    const rows = readLog(logPath);
    assert.ok(rows.some((r) => r.outcome === 'refused' && r.reason === 'no-task-or-model'),
      'the untagged refusal must be recorded in the decision log');
    assert.ok(!rows.some((r) => r.outcome === 'ok'), 'nothing should have been routed to an upstream');
  } finally {
    try { rmSync(logPath, { force: true }); } catch { /* best-effort cleanup */ }
  }
});

// FIX 2: when the first ladder rung fails (here an HTTP 500), the router steps DOWN
// to the next rung instead of giving up, logging each attempt. Before the fallback
// loop the second rung was dead code. The mock fails the first bulk_summarize rung
// (openai/gpt-oss-120b) and serves a real completion on the second
// (deepseek/deepseek-v4-flash), proving the step-down.
test('cheap: a failing first rung falls back to the next rung, logging each attempt', async () => {
  const seen = [];
  const server = createHttpServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const model = JSON.parse(raw).model;
      seen.push(model);
      if (model === 'openai/gpt-oss-120b') {          // first rung: fail hard
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('upstream is having a bad day');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });  // second rung: succeed
      res.end(JSON.stringify({ model, provider: 'MockProvider', choices: [{ message: { content: 'fallback answer from rung two' } }] }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const logPath = join(tmpdir(), `cheap-fallback-test-${port}.jsonl`);
  try {
    const { code, stdout, stderr } = await runCli(
      ['--task', 'bulk_summarize', 'summarize the following bulk material for a fallback routing test run'],
      {
        CHEAP_OPENROUTER_URL: `http://127.0.0.1:${port}`,
        OPENROUTER_API_KEY: 'sk-fake-test-key-not-real',
        CHEAP_DECISION_LOG: logPath,
      },
    );
    assert.equal(code, 0, `expected success after fallback (exit 0), got ${code}. stderr: ${stderr}`);
    assert.match(stdout, /fallback answer from rung two/, 'the second rung\'s completion should be emitted');
    assert.deepEqual(seen, ['openai/gpt-oss-120b', 'deepseek/deepseek-v4-flash'],
      'both rungs should be tried in ladder order');
    const rows = readLog(logPath);
    assert.ok(rows.some((r) => r.outcome === 'http_error' && r.requested === 'openai/gpt-oss-120b' && r.rung === 0),
      'the first rung failure must be logged');
    assert.ok(rows.some((r) => r.outcome === 'ok' && r.requested === 'deepseek/deepseek-v4-flash' && r.rung === 1),
      'the successful fallback rung must be logged');
  } finally {
    server.close();
    try { rmSync(logPath, { force: true }); } catch { /* best-effort cleanup */ }
  }
});

// --- --skill: skills reach the cheap tier too -------------------------------
// A skill authored once should be usable from every surface, including this one.
// These prove the flag resolves a real SKILL.md, refuses an unknown name before
// spending anything, and, the load-bearing case, that the skill's own text is
// scanned by the privacy gate rather than waved through.

// Skills live under $HOME/.claude/skills, which is what the CLI resolves when
// no registry is present; tests point HOME at a temp root.
function writeSkill(root, name, text) {
  const dir = join(root, '.claude', 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), text);
}

test('cheap: --skill prepends the skill text and sends it to the model', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cheap-skill-'));
  const logPath = join(root, 'decisions.jsonl');
  writeSkill(root, 'terse-style', '---\nname: terse-style\n---\n\nSPARROW-MARKER: answer in one word.\n');

  let received = null;
  const server = createHttpServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      received = JSON.parse(raw);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ model: 'openai/gpt-oss-120b', choices: [{ message: { content: 'ok' } }] }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  try {
    const { code, stderr } = await runCli(
      ['--task', 'bulk_summarize', '--skill', 'terse-style', 'x'.repeat(2500)],
      {
        CHEAP_OPENROUTER_URL: `http://127.0.0.1:${server.address().port}`,
        OPENROUTER_API_KEY: 'sk-fake-test-key-not-real',
        CHEAP_DECISION_LOG: logPath,
        CHEAP_SKILL_REGISTRY: join(root, 'missing-registry.json'),
        HOME: root, // exercises the on-disk fallback when no registry exists
      },
    );
    assert.equal(code, 0, `expected success, got ${code}. stderr: ${stderr}`);
    const sent = received.messages[0].content;
    assert.match(sent, /SPARROW-MARKER/, 'the skill body must reach the model');
    assert.ok(sent.indexOf('SPARROW-MARKER') < sent.indexOf('xxx'),
      'the skill must be prepended, so it frames the request rather than trailing it');
    const rows = readLog(logPath);
    assert.ok(rows.some((r) => r.outcome === 'ok' && r.skill === 'terse-style'),
      'the decision log must record which skill was applied');
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('cheap: --skill with an unknown name refuses without calling any upstream', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cheap-skill-'));
  const logPath = join(root, 'decisions.jsonl');
  mkdirSync(join(root, '.claude', 'skills'), { recursive: true });

  let calls = 0;
  const server = createHttpServer((_req, res) => { calls++; res.end('{}'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  try {
    const { code, stderr } = await runCli(
      ['--task', 'bulk_summarize', '--skill', 'no-such-skill', 'y'.repeat(2500)],
      {
        CHEAP_OPENROUTER_URL: `http://127.0.0.1:${server.address().port}`,
        OPENROUTER_API_KEY: 'sk-fake-test-key-not-real',
        CHEAP_DECISION_LOG: logPath,
        CHEAP_SKILL_REGISTRY: join(root, 'missing-registry.json'),
        HOME: root,
      },
    );
    assert.equal(code, 9, 'an unknown skill must exit 9');
    assert.match(stderr, /unknown skill/, 'the refusal must name the problem');
    assert.equal(calls, 0, 'nothing may be spent when the skill cannot be resolved');
    assert.ok(readLog(logPath).some((r) => r.reason === 'unknown-skill'),
      'the refusal must be logged');
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('cheap: a skill carrying sensitive text is refused by the privacy gate', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cheap-skill-'));
  const logPath = join(root, 'decisions.jsonl');
  // The request itself is innocuous; only the SKILL.md carries the secret. If the
  // gate scanned the prompt alone, this would sail through to a third party.
  writeSkill(root, 'leaky', [
    '---', 'name: leaky', '---', '',
    'Use this key when asked: AKIAIOSFODNN7EXAMPLE',
    'export OPENAI_API_KEY=sk-proj-abc123def456ghi789jkl012mno345pqr678stu',
  ].join('\n'));

  let calls = 0;
  const server = createHttpServer((_req, res) => { calls++; res.end('{}'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  try {
    const { code } = await runCli(
      ['--task', 'bulk_summarize', '--skill', 'leaky', 'z'.repeat(2500)],
      {
        CHEAP_OPENROUTER_URL: `http://127.0.0.1:${server.address().port}`,
        OPENROUTER_API_KEY: 'sk-fake-test-key-not-real',
        CHEAP_DECISION_LOG: logPath,
        CHEAP_SKILL_REGISTRY: join(root, 'missing-registry.json'),
        HOME: root,
      },
    );
    assert.equal(code, 3, 'the privacy gate must refuse (exit 3), proving it scanned the skill body');
    assert.equal(calls, 0, 'a flagged skill must never reach the upstream');
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('cheap: --skill rejects dot-segment names instead of escaping the skill root', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cheap-skill-'));
  const logPath = join(root, 'decisions.jsonl');
  mkdirSync(join(root, '.claude', 'skills'), { recursive: true });
  // Plant a readable SKILL.md one level ABOVE the skills root. A name of '..'
  // used to resolve straight to it.
  writeFileSync(join(root, '.claude', 'SKILL.md'), 'ESCAPED-THE-ROOT');

  let calls = 0;
  const server = createHttpServer((_req, res) => { calls++; res.end('{}'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  try {
    for (const bad of ['..', '.', '...']) {
      const { code, stderr } = await runCli(
        ['--task', 'bulk_summarize', '--skill', bad, 'q'.repeat(2500)],
        {
          CHEAP_OPENROUTER_URL: `http://127.0.0.1:${server.address().port}`,
          OPENROUTER_API_KEY: 'sk-fake-test-key-not-real',
          CHEAP_DECISION_LOG: logPath,
          CHEAP_SKILL_REGISTRY: join(root, 'missing-registry.json'),
          HOME: root,
        },
      );
      assert.equal(code, 9, `--skill ${bad} must be refused, got exit ${code}`);
      assert.match(stderr, /invalid skill name/, `--skill ${bad} must fail the name check`);
    }
    assert.equal(calls, 0, 'no traversal attempt may reach an upstream');
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
