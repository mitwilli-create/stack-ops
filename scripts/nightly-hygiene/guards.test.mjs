// guards.test.mjs: planted-input tests for the commit-time guard.
//
// Per AGENTS.md: a verification that cannot go red is not a verification. Every
// case here plants input that MUST be caught, and the clean cases prove the gate
// does not simply block everything.
//
// Run: node --test scripts/nightly-hygiene/guards.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { checkPath, checkContent, screen } from './guards.mjs';

const BAD_PATHS = [
  'cv.md',
  'data/cv.md',
  'applications.md',
  'data/hm-intel/anthropic.json',
  'apply-pack/sierra/tailored-cv.md',
  'interview-prep/notes.md',
  '.env',
  '.env.local',
  'config/.env.production',
  'keys/id_rsa',
  'certs/server.pem',
  'secrets/credentials.json',
  'gcp/service-account-prod.json',
  '.npmrc',
  '.netrc',
];

const GOOD_PATHS = [
  'src/index.mjs',
  'README.md',
  'scripts/build.mjs',
  'docs/cv-formatting-notes.md', // contains "cv" but is not cv.md
  'test/env-loader.test.mjs',    // contains "env" but is not .env
  'package.json',
];

test('deny paths are blocked', () => {
  for (const p of BAD_PATHS) {
    assert.equal(checkPath(p).blocked, true, `expected BLOCKED: ${p}`);
  }
});

test('ordinary source paths are allowed', () => {
  for (const p of GOOD_PATHS) {
    assert.equal(checkPath(p).blocked, false, `expected ALLOWED: ${p}`);
  }
});

const SECRETS = {
  'anthropic.txt': 'ANTHROPIC_API_KEY=sk-ant-api03-' + 'A'.repeat(40),
  'github.txt': 'token: ghp_' + 'b'.repeat(36),
  'aws.txt': 'aws_access_key_id = AKIAIOSFODNN7EXAMPLE',
  'google.txt': 'key: AIza' + 'C'.repeat(35),
  'slack.txt': 'xoxb-' + 'g'.repeat(29),
  'pem.txt': '-----BEGIN RSA PRIVATE KEY-----\nMIIE\n',
  'openai.txt': 'OPENAI_API_KEY=sk-' + 'd'.repeat(40),
  'pplx.txt': 'PERPLEXITY=pplx-' + 'e'.repeat(36),
  'xai.txt': 'XAI=xai-' + 'f'.repeat(36),
};

const CLEAN = {
  'clean.mjs': 'export const key = process.env.ANTHROPIC_API_KEY; // name only, no value\n',
  'clean.md': 'Set `ANTHROPIC_API_KEY` in your vault. Never commit the value.\n',
  'short.txt': 'sk-tooshort\n',
};

test('planted secret values are blocked by content scan', () => {
  const dir = mkdtempSync(join(tmpdir(), 'guards-secret-'));
  try {
    for (const [name, body] of Object.entries(SECRETS)) {
      writeFileSync(join(dir, name), body);
      const r = checkContent(dir, name);
      assert.equal(r.blocked, true, `expected BLOCKED by content: ${name}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('key NAMES without values are not blocked', () => {
  const dir = mkdtempSync(join(tmpdir(), 'guards-clean-'));
  try {
    for (const [name, body] of Object.entries(CLEAN)) {
      writeFileSync(join(dir, name), body);
      const r = checkContent(dir, name);
      assert.equal(r.blocked, false, `expected ALLOWED: ${name} (${r.reason || ''})`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('binary content is skipped, not misread as a secret', () => {
  const dir = mkdtempSync(join(tmpdir(), 'guards-bin-'));
  try {
    // A NUL byte early in the file marks it binary; the scanner must bail out.
    writeFileSync(join(dir, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0x00]));
    assert.equal(checkContent(dir, 'blob.bin').blocked, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('screen() partitions a mixed staging set and blocks the bad ones', () => {
  const dir = mkdtempSync(join(tmpdir(), 'guards-screen-'));
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    mkdirSync(join(dir, 'data/hm-intel'), { recursive: true });
    writeFileSync(join(dir, 'src/ok.mjs'), 'export const a = 1;\n');
    writeFileSync(join(dir, 'src/leak.mjs'), 'const k = "sk-ant-api03-' + 'Z'.repeat(40) + '";\n');
    writeFileSync(join(dir, 'data/hm-intel/x.json'), '{}\n');

    const { allowed, blocked } = screen(dir, ['src/ok.mjs', 'src/leak.mjs', 'data/hm-intel/x.json']);

    assert.deepEqual(allowed, ['src/ok.mjs']);
    assert.equal(blocked.length, 2);
    assert.ok(blocked.some((b) => b.path === 'src/leak.mjs' && /secret pattern/.test(b.reason)));
    assert.ok(blocked.some((b) => b.path === 'data/hm-intel/x.json' && /deny pattern/.test(b.reason)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a deleted file does not crash the content scan', () => {
  const dir = mkdtempSync(join(tmpdir(), 'guards-gone-'));
  try {
    assert.equal(checkContent(dir, 'never-existed.md').blocked, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
