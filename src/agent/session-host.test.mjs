import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SessionStore } from './session-store.mjs';
import { createSessionHost } from './session-host.mjs';

test('handles a prompt through the context, routing, dispatch, and history seams', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stack-ops-host-'));
  try {
    const store = new SessionStore(root);
    const seen = {};
    const host = createSessionHost({
      store,
      context: async ({ prompt }) => ({ systemPrompt: 'MEMORY_FOR_' + prompt, sources: [], skills: [] }),
      route: async ({ text }) => ({ lane: 'frontier', taskType: 'frontier_synthesis', selected: { handle: 'test:model' }, targets: [], signals: [text] }),
      dispatch: async ({ prompt, decision, context }) => {
        seen.prompt = prompt;
        seen.decision = decision;
        seen.context = context;
        return { answer: 'Answer with context.' };
      },
      localAnswer: () => null,
    });

    const result = await host.submit({ prompt: 'Use my instructions.' });

    assert.equal(result.answer, 'Answer with context.');
    assert.equal(seen.context.systemPrompt, 'MEMORY_FOR_Use my instructions.');
    assert.equal(seen.decision.selected.handle, 'test:model');
    assert.equal(result.session.messages.length, 2);
    assert.equal(result.session.messages[1].metadata.lane, 'frontier');
    assert.equal('recalledMemories' in result.metadata, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('forwards the caller-supplied input (e.g. paths) through to dispatch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stack-ops-host-input-'));
  try {
    const store = new SessionStore(root);
    let seenInput = null;
    const host = createSessionHost({
      store,
      context: async () => ({ systemPrompt: '', sources: [], skills: [] }),
      route: async () => ({ lane: 'toil', taskType: 'bulk_mechanical_edit', executionTask: 'bulk_mechanical_edit', selected: { handle: 'test:model' }, targets: [{ handle: 'test:model' }] }),
      dispatch: async ({ input }) => {
        seenInput = input;
        return { answer: 'done' };
      },
      localAnswer: () => null,
    });

    await host.submit({ prompt: 'rename these files', input: { paths: ['a.txt', 'b.txt'] } });

    assert.deepEqual(seenInput, { paths: ['a.txt', 'b.txt'] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('answers local clock prompts without routing or dispatch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stack-ops-local-host-'));
  try {
    const store = new SessionStore(root);
    let routed = false;
    const host = createSessionHost({
      store,
      route: async () => { routed = true; throw new Error('should not route'); },
      dispatch: async () => { throw new Error('should not dispatch'); },
      context: async () => { throw new Error('should not assemble context'); },
      localAnswer: () => 'Local time: 8:23 PM.',
    });

    const result = await host.submit({ prompt: 'What time is it?' });

    assert.equal(result.answer, 'Local time: 8:23 PM.');
    assert.equal(result.metadata.taskType, 'local_clock');
    assert.equal(routed, false);
    assert.equal(result.session.messages.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('refuses privacy-gated prompts before loading context or dispatching', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stack-ops-private-host-'));
  try {
    const store = new SessionStore(root);
    const host = createSessionHost({
      store,
      route: async () => ({ lane: 'local-only', taskType: 'local_only', note: 'privacy gate refused' }),
      context: async () => { throw new Error('context must not load'); },
      dispatch: async () => { throw new Error('dispatch must not run'); },
      localAnswer: () => null,
    });

    const result = await host.submit({ prompt: 'Process this credential value.' });

    assert.equal(result.refused, true);
    assert.equal(result.metadata.lane, 'local-only');
    assert.match(result.answer, /privacy gate refused/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
