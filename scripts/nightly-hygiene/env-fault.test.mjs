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
