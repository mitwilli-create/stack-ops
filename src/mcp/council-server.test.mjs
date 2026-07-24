/**
 * council-server.test.mjs - Node native test runner (--test)
 *
 * Unit-tests the EXECUTION wrapper (run_council / run_researcher / run_dealbreaker)
 * with an injected mock engine, so NO model is dispatched and NO money is spent.
 *
 * Run: node --test src/mcp/council-server.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  isDryRun,
  perCallCapUsd,
  monthlyBudgetUsd,
  resolveLineup,
  estimateLineupCostUsd,
  runEngineTool,
  buildDealbreakerPrompt,
  loadReportText,
} from './council-server.mjs';

function mockEngine({ costPerModel = 0.01 } = {}) {
  const calls = [];
  return {
    calls,
    DEFAULT_LINEUP: ['anthropic:claude-sonnet-4-6'],
    RESEARCH_COUNCIL_LINEUPS: {
      default: ['anthropic:claude-sonnet-4-6'],
      fanout: ['a:1', 'b:2', 'c:3', 'd:4'],
      research5: ['a:1', 'b:2', 'c:3', 'd:4', 'e:5'],
    },
    estimateCostUsd: () => costPerModel,
    async callCouncil(args) {
      calls.push(args);
      return {
        totalMs: 5,
        missingKeys: [],
        results: [{ model: args.models[0], content: 'ok', tokens: 10, costUsd: 0.001, ms: 5 }],
      };
    },
  };
}

// Snapshot + restore the env keys these functions read.
function withEnv(overrides, fn) {
  const keys = ['COUNCIL_DRY_RUN', 'COUNCIL_MAX_CALL_USD', 'MONTHLY_BUDGET_USD', 'COUNCIL_EST_OUTPUT_TOKENS'];
  const saved = {};
  for (const k of keys) saved[k] = process.env[k];
  for (const k of keys) delete process.env[k];
  for (const [k, v] of Object.entries(overrides)) process.env[k] = v;
  return Promise.resolve(fn()).finally(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
}

function parse(result) {
  return JSON.parse(result.content[0].text);
}

test('isDryRun parses truthy/falsey values', () => {
  assert.equal(isDryRun({ COUNCIL_DRY_RUN: '1' }), true);
  assert.equal(isDryRun({ COUNCIL_DRY_RUN: 'true' }), true);
  assert.equal(isDryRun({ COUNCIL_DRY_RUN: 'yes' }), true);
  assert.equal(isDryRun({ COUNCIL_DRY_RUN: '0' }), false);
  assert.equal(isDryRun({ COUNCIL_DRY_RUN: 'false' }), false);
  assert.equal(isDryRun({ COUNCIL_DRY_RUN: '' }), false);
  assert.equal(isDryRun({}), false);
});

test('perCallCapUsd defaults to $5 and honors a valid override', () => {
  assert.equal(perCallCapUsd({}), 5);
  assert.equal(perCallCapUsd({ COUNCIL_MAX_CALL_USD: '2.5' }), 2.5);
  assert.equal(perCallCapUsd({ COUNCIL_MAX_CALL_USD: 'nonsense' }), 5);
  assert.equal(perCallCapUsd({ COUNCIL_MAX_CALL_USD: '-3' }), 5);
});

test('monthlyBudgetUsd is null unless a positive number is set', () => {
  assert.equal(monthlyBudgetUsd({}), null);
  assert.equal(monthlyBudgetUsd({ MONTHLY_BUDGET_USD: '100' }), 100);
  assert.equal(monthlyBudgetUsd({ MONTHLY_BUDGET_USD: '0' }), null);
});

test('resolveLineup: array verbatim, named key, single id, default fallback', () => {
  const eng = mockEngine();
  assert.deepEqual(resolveLineup(eng, ['x:1', 'y:2']), ['x:1', 'y:2']);
  assert.deepEqual(resolveLineup(eng, 'fanout'), eng.RESEARCH_COUNCIL_LINEUPS.fanout);
  assert.deepEqual(resolveLineup(eng, 'openai:gpt-5'), ['openai:gpt-5']);
  assert.deepEqual(resolveLineup(eng, undefined), eng.DEFAULT_LINEUP);
  assert.deepEqual(resolveLineup(eng, ''), eng.DEFAULT_LINEUP);
});

test('estimateLineupCostUsd scales with lineup size', () => {
  const eng = mockEngine({ costPerModel: 0.02 });
  const one = estimateLineupCostUsd(eng, ['a:1'], 'short prompt');
  const four = estimateLineupCostUsd(eng, ['a:1', 'b:2', 'c:3', 'd:4'], 'short prompt');
  assert.ok(Math.abs(one - 0.02) < 1e-9);
  assert.ok(Math.abs(four - 0.08) < 1e-9);
});

test('runEngineTool DRY-RUN dispatches nothing and spends nothing', async () => {
  const eng = mockEngine();
  await withEnv({ COUNCIL_DRY_RUN: '1' }, async () => {
    const out = parse(await runEngineTool({ toolName: 'run_council', prompt: 'hi', engine: eng }));
    assert.equal(out.dryRun, true);
    assert.deepEqual(out.lineup, eng.DEFAULT_LINEUP);
    assert.equal(eng.calls.length, 0, 'callCouncil must NOT be invoked in dry-run');
  });
});

test('runEngineTool live path calls callCouncil once with the resolved lineup', async () => {
  const eng = mockEngine();
  await withEnv({}, async () => {
    const out = parse(await runEngineTool({ toolName: 'run_council', prompt: 'hi', models: 'fanout', engine: eng }));
    assert.equal(out.dryRun, false);
    assert.equal(eng.calls.length, 1);
    assert.deepEqual(eng.calls[0].models, eng.RESEARCH_COUNCIL_LINEUPS.fanout);
    assert.equal(out.results.length, 1);
    assert.equal(out.results[0].content, 'ok');
  });
});

test('runEngineTool refuses when the per-call cap is exceeded (no dispatch)', async () => {
  const eng = mockEngine({ costPerModel: 1 });
  await withEnv({ COUNCIL_MAX_CALL_USD: '0.001' }, async () => {
    const res = await runEngineTool({ toolName: 'run_council', prompt: 'hi', engine: eng });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /per-call cap exceeded/);
    assert.equal(eng.calls.length, 0);
  });
});

test('runEngineTool refuses when a single call exceeds MONTHLY_BUDGET_USD (no dispatch)', async () => {
  const eng = mockEngine({ costPerModel: 50 });
  await withEnv({ COUNCIL_MAX_CALL_USD: '1000', MONTHLY_BUDGET_USD: '10' }, async () => {
    const res = await runEngineTool({ toolName: 'run_council', prompt: 'hi', engine: eng });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /MONTHLY_BUDGET_USD/);
    assert.equal(eng.calls.length, 0);
  });
});

test('runEngineTool rejects an empty prompt', async () => {
  const eng = mockEngine();
  const res = await runEngineTool({ toolName: 'run_council', prompt: '   ', engine: eng });
  assert.equal(res.isError, true);
  assert.equal(eng.calls.length, 0);
});

test('buildDealbreakerPrompt embeds the report text and adjudication framing', () => {
  const p = buildDealbreakerPrompt('CLAIM: the sky is green.');
  assert.match(p, /dealbreaker/i);
  assert.match(p, /CLAIM: the sky is green\./);
});

test('loadReportText passes inline text through', () => {
  assert.equal(loadReportText('just some inline text'), 'just some inline text');
});

test('loadReportText reads a file ONLY within COUNCIL_REPORTS_DIR, and fails closed otherwise', () => {
  const dir = mkdtempSync(join(tmpdir(), 'db-report-'));
  try {
    writeFileSync(join(dir, 'report.md'), '# Report\nbody');
    // Opted in + inside the root -> read (relative path resolved against the root).
    assert.equal(loadReportText('report.md', { COUNCIL_REPORTS_DIR: dir }), '# Report\nbody');
    // Same absolute path but NO opt-in -> fail closed, returned as text.
    assert.equal(loadReportText(join(dir, 'report.md'), {}), join(dir, 'report.md'));
    // Traversal escaping the root -> rejected, returned as text (not read).
    assert.equal(
      loadReportText('../../../../etc/passwd', { COUNCIL_REPORTS_DIR: dir }),
      '../../../../etc/passwd',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
