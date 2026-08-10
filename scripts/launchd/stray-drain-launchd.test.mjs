import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const plist = readFileSync(join(here, 'com.mitchell.stack-ops.stray-drain.plist'), 'utf8');
const wrapper = readFileSync(join(here, 'stack-ops-stray-drain-nohup-wrapper.zsh'), 'utf8');
const installer = readFileSync(join(here, '..', 'install-stray-drain-launchd.zsh'), 'utf8');

test('stray drain launchd delegates through the Tahoe nohup wrapper', () => {
  assert.match(plist, /<string>\/bin\/zsh<\/string>/);
  assert.match(plist, /__STACK_OPS_RUNTIME_WRAPPER__/);
  assert.match(plist, /<key>AbandonProcessGroup<\/key>\s*<true\/>/);
  assert.doesNotMatch(plist, /<string>[^<]*\/node<\/string>/);
  assert.match(wrapper, /"\$\{NODE_BIN\}" scripts\/memory-sweep\/stray-drain\.mjs/);
  assert.match(wrapper, /\/usr\/bin\/env -i/);
  assert.match(wrapper, /__STACK_OPS_REPO__/);
  assert.match(wrapper, /__STACK_OPS_LOG_DIR__/);
});

test('installer renders, validates, and bootstraps the exact wrapper', () => {
  assert.match(installer, /stray-drain-nohup-wrapper\.zsh/);
  assert.match(installer, /plutil -lint/);
  assert.match(installer, /launchctl bootstrap/);
  assert.match(installer, /com\.mitchell\.stack-ops\.stray-drain/);
});

test('rendered wrapper detaches the exact scheduler command', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stray-drain-nohup-'));
  try {
    const repo = join(root, 'repo');
    const log = join(root, 'logs');
    const bin = join(root, 'bin');
    const marker = join(log, 'launchd.out');
    mkdirSync(join(repo, 'scripts', 'memory-sweep'), { recursive: true });
    mkdirSync(bin);
    const fakeNode = join(bin, 'node');
    writeFileSync(
      fakeNode,
      '#!/bin/zsh\nprint -r -- "${UNRELATED_FLAG-unset}|${OPENROUTER_API_KEY-unset}|$1"\n',
      { mode: 0o700 },
    );
    chmodSync(fakeNode, 0o700);
    const rendered = join(root, 'wrapper.zsh');
    writeFileSync(
      rendered,
      wrapper.replaceAll('__STACK_OPS_REPO__', repo).replaceAll('__STACK_OPS_LOG_DIR__', log),
      { mode: 0o700 },
    );
    chmodSync(rendered, 0o700);
    const result = spawnSync('/bin/zsh', [rendered], {
      env: {
        HOME: root,
        PATH: `${bin}:/usr/bin:/bin`,
        UNRELATED_FLAG: 'present',
        [['OPENROUTER', 'API', 'KEY'].join('_')]: 'test-openrouter',
      },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const deadline = Date.now() + 2_000;
    while (
      (!existsSync(marker) || readFileSync(marker, 'utf8').length === 0)
      && Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(
      readFileSync(marker, 'utf8').trim(),
      'unset|test-openrouter|scripts/memory-sweep/stray-drain.mjs',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
