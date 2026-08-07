import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SessionStore } from './session-store.mjs';
import { createSessionHost } from './session-host.mjs';
import { createAgentServer } from './server.mjs';

test('serves session history, status metadata, and chat messages over the local API', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stack-ops-server-'));
  const store = new SessionStore(root);
  const host = createSessionHost({
    store,
    context: async () => ({ systemPrompt: 'test', sources: [], memories: [], skills: [{ name: 'file-hygiene' }] }),
    route: async () => ({ lane: 'frontier', taskType: 'frontier_synthesis', selected: { handle: 'test:model' }, signals: [] }),
    dispatch: async () => ({ answer: 'server answer', target: { handle: 'test:model' } }),
    localAnswer: () => null,
  });
  const server = createAgentServer({
    sessionHost: host,
    connectors: [{ name: 'council', transport: 'stdio', credentialNames: [] }],
    skills: [{ name: 'file-hygiene' }],
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const base = 'http://127.0.0.1:' + address.port;

  try {
    const created = await fetch(base + '/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Console test' }),
    }).then((response) => response.json());
    assert.equal(created.title, 'Console test');

    const message = await fetch(base + '/api/sessions/' + created.id + '/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'Test the console' }),
    }).then((response) => response.json());
    assert.equal(message.answer, 'server answer');
    assert.equal(message.metadata.target, 'test:model');

    const status = await fetch(base + '/api/status').then((response) => response.json());
    assert.equal(status.connectors[0].name, 'council');
    assert.deepEqual(status.connectors[0].credentialNames, []);
    assert.equal(status.skills[0].name, 'file-hygiene');

    const sessions = await fetch(base + '/api/sessions').then((response) => response.json());
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].messageCount, 2);

    const shell = await fetch(base + '/').then((response) => response.text());
    assert.match(shell, /conversation-list/);
    assert.match(shell, /chat-panel/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
