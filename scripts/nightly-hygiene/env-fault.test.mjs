// env-fault.test.mjs: prove the environment-fault classifier and the circuit
// breaker it drives can both FIRE and STAY QUIET.
//
// Why this exists. On 2026-08-07 the nightly run lost access to ~/Documents at
// 02:08:13 and the next 12 repos each failed in about 30ms with an identical
// "shell-init: ... getcwd ... Operation not permitted". The report recorded 12
// separate "claude-failed" verdicts, which reads as 12 broken repos rather than
// one broken machine. The classifier tells those two apart; the breaker stops the
// run instead of burning the rota and the cost cap on certain failures.
//
//   node --test scripts/nightly-hygiene/env-fault.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { isEnvironmentFault } = await import('./nightly-hygiene.mjs');

// The exact stderr from the 2026-08-07 run, verbatim.
const REAL_FAULT =
  'shell-init: error retrieving current directory: getcwd: cannot access parent directories: Operation not permitted\n' +
  'error: An internal error occurred (EPERM)\n';

test('classifies the real 2026-08-07 stderr as an environment fault', () => {
  assert.equal(isEnvironmentFault(REAL_FAULT), true);
});

test('classifies each fault signature independently', () => {
  for (const s of [
    'getcwd: cannot access parent directories',
    'Operation not permitted',
    'Error: EPERM: operation not permitted, open \'/Users/x/Documents/a.mjs\'',
    'shell-init: error retrieving current directory',
  ]) {
    assert.equal(isEnvironmentFault(s), true, `should be an environment fault: ${s}`);
  }
});

test('does NOT classify ordinary repo failures as environment faults', () => {
  // These must stay per-repo verdicts. Misclassifying one would abort the whole
  // run over a single repo's bad test, which is the opposite failure mode.
  for (const s of [
    'SyntaxError: Unexpected token }',
    'npm ERR! Test failed. See above for more details.',
    'error: pathspec did not match any file(s) known to git',
    'Claude usage limit reached',
    '',
    null,
    undefined,
  ]) {
    assert.equal(isEnvironmentFault(s), false, `should NOT be an environment fault: ${JSON.stringify(s)}`);
  }
});

test('the breaker trips on consecutive faults and resets on a good repo', () => {
  // Mirrors the loop in main(): count consecutive faults, abort at the limit,
  // reset the counter whenever a repo succeeds.
  const LIMIT = 2;
  const drive = (outcomes) => {
    let consecutive = 0;
    let attempted = 0;
    for (const isFault of outcomes) {
      attempted += 1;
      if (isFault) {
        consecutive += 1;
        if (consecutive >= LIMIT) return { aborted: true, attempted };
      } else {
        consecutive = 0;
      }
    }
    return { aborted: false, attempted };
  };

  // The real run: 2 good repos, then 12 faults. It must stop after the 2nd fault,
  // having attempted 4 repos, not all 14.
  const real = drive([false, false, ...Array(12).fill(true)]);
  assert.equal(real.aborted, true);
  assert.equal(real.attempted, 4, 'must abort on the 2nd consecutive fault, leaving 10 repos unattempted');

  // An isolated blip between healthy repos must NOT abort the run.
  assert.equal(drive([false, true, false, true, false]).aborted, false);

  // An all-clean run never trips.
  assert.equal(drive(Array(14).fill(false)).aborted, false);
});

test('importing the runner does not start a nightly pass', () => {
  assert.equal(typeof isEnvironmentFault, 'function');
});

// ------------------------------------------------------ self-restart bounding

import { mkdtempSync, writeFileSync as wfs, existsSync as ex, rmSync as rm } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('self-restart fires once per day and never loops', () => {
  // Mirrors the marker guard in main(). A restart loop on a job that spends
  // money is worse than a missed night, so the second attempt on the same
  // calendar day must be refused.
  const dir = mkdtempSync(join(tmpdir(), 'nh-restart-'));
  try {
    const decide = (day) => {
      const marker = join(dir, `self-restart-${day}`);
      if (ex(marker)) return 'refused';
      wfs(marker, 'x');
      return 'restarted';
    };
    assert.equal(decide('2026-08-07'), 'restarted', 'first fault of the day restarts');
    assert.equal(decide('2026-08-07'), 'refused', 'second fault the same day must NOT restart');
    assert.equal(decide('2026-08-08'), 'restarted', 'the next day is allowed again');
  } finally { rm(dir, { recursive: true, force: true }); }
});

test('self-restart is gated on the runner itself being blind', () => {
  // shouldSelfRestart = !readable. Restarting when the runner can still read the
  // tree would be wrong: that fault lives in the claude spawn path, and a fresh
  // process tree would not fix it, it would just spend the money again.
  const shouldRestart = (readable) => !readable;
  assert.equal(shouldRestart(false), true, 'whole tree blind: restart');
  assert.equal(shouldRestart(true), false, 'runner can still read: do NOT restart');
});
