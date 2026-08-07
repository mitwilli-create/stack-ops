// memory-sweep.test.mjs: prove the merge compression floor can FAIL.
//
// The floor shipped in e38cfb2 after the 2026-08-06 run merged 4 stack-ops files
// totalling 8733 bytes into 1287 (an 85% cut) while claiming it lost no fact. It
// had in fact dropped "Composer" from the flat-rate routing rule.
//
// As of 2026-08-07 the floor had never rejected anything in a live run: 5
// merge_facts operations across 4 sweeps all passed it. A guard that has only
// ever passed is not known to work, so this plants the real numbers and proves
// the reject path fires, and that a legitimate dedup still gets through.
//
//   node --test scripts/memory-sweep/memory-sweep.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { validateOp } = await import('./memory-sweep.mjs');

/** Build a throwaway project dir with `sizes` bytes per source file. */
function fixture(sizes) {
  const dir = mkdtempSync(join(tmpdir(), 'memsweep-'));
  const facts = [];
  sizes.forEach((bytes, i) => {
    const name = `fact-${i}.md`;
    writeFileSync(join(dir, name), 'x'.repeat(bytes));
    facts.push({ file: name });
  });
  facts.push({ file: 'canonical.md' });
  return { dir, facts, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// The real 2026-08-06 numbers: 4 files totalling 8733 bytes.
const REAL_SOURCES = [2183, 2183, 2183, 2184];

test('rejects the real 8733B -> 1287B merge that lost a fact', () => {
  const g = fixture(REAL_SOURCES);
  try {
    const r = validateOp(g, {
      op: 'merge_facts',
      into: 'canonical.md',
      from: g.facts.slice(0, 4).map((f) => f.file),
      new_body: 'y'.repeat(1287),
    });
    assert.equal(r.ok, false, 'an 85% cut must be rejected');
    assert.match(r.why, /summarising, not merging/);
    assert.match(r.why, /15%/);
  } finally { g.cleanup(); }
});

test('allows a legitimate dedup that keeps 69% of its sources', () => {
  const g = fixture(REAL_SOURCES);
  try {
    const r = validateOp(g, {
      op: 'merge_facts',
      into: 'canonical.md',
      from: g.facts.slice(0, 4).map((f) => f.file),
      new_body: 'y'.repeat(6000),
    });
    assert.equal(r.ok, true, `a 69% keep is real dedup and must pass, got: ${r.why}`);
  } finally { g.cleanup(); }
});

test('rejects just below the 40% floor and accepts just above it', () => {
  const g = fixture(REAL_SOURCES);
  const total = REAL_SOURCES.reduce((a, b) => a + b, 0);
  try {
    const below = validateOp(g, {
      op: 'merge_facts', into: 'canonical.md',
      from: g.facts.slice(0, 4).map((f) => f.file),
      new_body: 'y'.repeat(Math.floor(total * 0.39)),
    });
    assert.equal(below.ok, false, '39% must be rejected');

    const above = validateOp(g, {
      op: 'merge_facts', into: 'canonical.md',
      from: g.facts.slice(0, 4).map((f) => f.file),
      new_body: 'y'.repeat(Math.ceil(total * 0.45)),
    });
    assert.equal(above.ok, true, `45% must pass, got: ${above.why}`);
  } finally { g.cleanup(); }
});

test('importing the module does not start a sweep', () => {
  // If the main-guard regressed, importing above would have run a live sweep and
  // this file would never reach here cleanly. Asserting the export exists is the
  // cheap standing proof that import stayed side-effect free.
  assert.equal(typeof validateOp, 'function');
});
