import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runAsk } from './ask-core.mjs';

test('passes assembled memory context to the selected dispatcher', async () => {
  const seen = {};
  const result = await runAsk(
    { text: 'Follow my operating rules.' },
    {
      localAnswer: () => null,
      context: async ({ prompt }) => ({
        systemPrompt: 'CANONICAL_CONTEXT_FOR_' + prompt,
        sources: [{ path: 'memory.md' }],
        skills: [],
      }),
      route: async ({ text }) => ({
        lane: 'frontier',
        taskType: 'frontier_synthesis',
        selected: { handle: 'test:model' },
        targets: [{ handle: 'test:model' }],
        signals: [text],
      }),
      dispatch: async (payload) => {
        Object.assign(seen, payload);
        return { answer: 'grounded answer', target: { handle: 'test:model' } };
      },
    },
  );

  assert.equal(result.answer, 'grounded answer');
  assert.equal(seen.context.systemPrompt, 'CANONICAL_CONTEXT_FOR_Follow my operating rules.');
  assert.equal(seen.decision.selected.handle, 'test:model');
});

test('dry runs classify without recalling memory or dispatching', async () => {
  const result = await runAsk(
    { text: 'Rename and organize these files', dryRun: true },
    {
      context: async () => { throw new Error('memory should not load in a dry run'); },
      route: async () => ({
        lane: 'toil',
        taskType: 'toil',
        selected: { handle: 'test:model' },
        targets: [{ handle: 'test:model' }],
        signals: ['bounded-mechanical-scope'],
      }),
      dispatch: async () => { throw new Error('dry run should not dispatch'); },
    },
  );

  assert.equal(result.decision.lane, 'toil');
  assert.equal(result.context, null);
});
