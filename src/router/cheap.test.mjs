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
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), 'cheap.mjs');

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
    const child = spawn('node', [CLI, 'summarize the following bulk material for a test run'], {
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
