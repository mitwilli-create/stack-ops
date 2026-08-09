import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { answerLocalPrompt } from './local-handlers.mjs';
import { assembleAgentContext } from './context-assembler.mjs';
import { readConnectorRegistry } from './connector-registry.mjs';
import { SessionStore } from './session-store.mjs';

test('answers time queries from the local clock without a model call', () => {
  const answer = answerLocalPrompt('What time is it?', {
    now: new Date('2026-08-06T03:23:39.000Z'),
    timeZone: 'America/Los_Angeles',
  });

  assert.match(answer, /8:23 PM/);
  assert.match(answer, /August 5, 2026/);
});

test('leaves non-clock prompts available for normal routing', () => {
  assert.equal(answerLocalPrompt('What should I rename these files?'), null);
});

test('assembles canonical memory and relevant skills without a recalled index', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stack-ops-context-'));
  try {
    await mkdir(join(root, 'identity-and-profile'), { recursive: true });
    await mkdir(join(root, 'project-memory', 'stack-ops'), { recursive: true });
    await mkdir(join(root, 'skills', 'file-hygiene'), { recursive: true });
    await writeFile(join(root, 'identity-and-profile', 'CLAUDE.md'), 'GLOBAL_OPERATOR_RULE');
    await writeFile(join(root, 'project-memory', 'stack-ops', 'MEMORY.md'), 'STACK_OPS_RULE');
    await writeFile(join(root, 'skills', 'file-hygiene', 'SKILL.md'), `---
name: file-hygiene
description: Rename and organize files safely
---
FILE_HYGIENE_RULE`);

    const context = await assembleAgentContext({
      prompt: 'Rename and organize these files',
      memoryRoot: root,
      skillRoots: [join(root, 'skills')],
    });

    assert.match(context.systemPrompt, /GLOBAL_OPERATOR_RULE/);
    assert.match(context.systemPrompt, /STACK_OPS_RULE/);
    assert.match(context.systemPrompt, /FILE_HYGIENE_RULE/);
    assert.equal(context.skills[0].name, 'file-hygiene');
    assert.equal('memories' in context, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('lists configured MCP connectors without exposing credential values', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stack-ops-connectors-'));
  try {
    const configPath = join(root, '.mcp.json');
    await writeFile(configPath, JSON.stringify({
      mcpServers: {
        github: { type: 'http', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer ${GITHUB_TOKEN}' } },
        council: { command: 'node', args: ['src/mcp/council-server.mjs'] },
      },
    }));

    const connectors = await readConnectorRegistry(configPath);

    assert.deepEqual(connectors.map((connector) => connector.name), ['github', 'council']);
    assert.equal(connectors[0].credentialNames[0], 'GITHUB_TOKEN');
    assert.equal(connectors[0].url, 'https://example.test/mcp');
    assert.equal(connectors[0].headers, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('persists sessions and messages in the local state directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stack-ops-sessions-'));
  try {
    const store = new SessionStore(root);
    const session = await store.createSession('Routing test');
    await store.appendMessage(session.id, { role: 'user', content: 'What time is it?' });
    await store.appendMessage(session.id, { role: 'assistant', content: 'It is local.' });

    const loaded = await store.getSession(session.id);
    assert.equal(loaded.title, 'Routing test');
    assert.equal(loaded.messages.length, 2);
    assert.equal((await store.listSessions())[0].id, session.id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
