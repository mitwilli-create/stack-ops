import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readlinkSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const plist = readFileSync(join(here, 'com.mitchell.stack-ops.stray-drain.plist'), 'utf8');
const wrapper = readFileSync(join(here, 'stack-ops-stray-drain-nohup-wrapper.zsh'), 'utf8');
const bootstrapSource = readFileSync(join(here, 'stray-drain-bootstrap.mjs'), 'utf8');
const installerHelperSource = readFileSync(join(here, 'stray-drain-install-files.mjs'), 'utf8');
const installer = readFileSync(join(here, '..', 'install-stray-drain-launchd.zsh'), 'utf8');

test('stray drain launchd delegates through the Tahoe nohup wrapper', () => {
  assert.match(plist, /<string>\/bin\/zsh<\/string>/);
  assert.match(plist, /__STACK_OPS_RUNTIME_WRAPPER__/);
  assert.match(plist, /<key>AbandonProcessGroup<\/key>\s*<true\/>/);
  assert.doesNotMatch(plist, /<string>[^<]*\/node<\/string>/);
  assert.match(wrapper, /"\$\{NODE_BIN\}" "\$\{BOOTSTRAP\}"/);
  assert.match(wrapper, /--credential-fd 0/);
  assert.match(wrapper, /\/usr\/bin\/env -i/);
  assert.doesNotMatch(wrapper, /CLEAN_ENV\+=\("\$\{CHEAP_KEY_NAME\}=\$\{CHEAP_KEY_VALUE\}"\)/);
  assert.doesNotMatch(wrapper, /^\s*cd\s+/m);
  assert.match(wrapper, /__STACK_OPS_REPO__/);
  assert.match(wrapper, /__STACK_OPS_LOG_DIR__/);
});

test('installer renders, validates, and bootstraps the exact wrapper', () => {
  assert.match(installer, /stray-drain-install-files\.mjs/);
  assert.match(installer, /umask 077/);
  assert.match(installer, /plutil -lint/);
  assert.match(installer, /launchctl bootstrap/);
  assert.match(installer, /com\.mitchell\.stack-ops\.stray-drain/);
});

test('installer helper securely creates every missing HOME-scoped parent on first install', () => {
  const root = mkdtempSync(join(tmpdir(), 'stray-drain-installer-fresh-home-'));
  try {
    const home = join(root, 'home');
    const repo = dirname(dirname(here));
    const runtimeDir = join(home, '.local', 'stack-ops');
    const plistDir = join(home, 'Library', 'LaunchAgents');
    const logDir = join(home, 'Library', 'Logs', 'stack-ops', 'stray-drain');
    mkdirSync(home, { mode: 0o700 });

    const result = spawnSync(process.execPath, [join(here, 'stray-drain-install-files.mjs'), 'prepare',
      '--repo', repo,
      '--runtime-dir', runtimeDir,
      '--plist-dir', plistDir,
      '--log-dir', logDir,
    ], { env: { ...process.env, HOME: home }, encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr);
    for (const path of [
      join(home, '.local'), runtimeDir,
      join(home, 'Library'), join(home, 'Library', 'Logs'), join(home, 'Library', 'Logs', 'stack-ops'),
      logDir, plistDir,
    ]) {
      const stat = lstatSync(path);
      assert.equal(stat.isDirectory(), true, path);
      assert.equal(stat.isSymbolicLink(), false, path);
      assert.equal((stat.mode & 0o777), 0o700, path);
    }
    assert.equal((lstatSync(join(logDir, 'launchd.out')).mode & 0o777), 0o600);
    assert.equal((lstatSync(join(logDir, 'launchd.err')).mode & 0o777), 0o600);
    assert.equal((lstatSync(join(plistDir, 'com.mitchell.stack-ops.stray-drain.plist')).mode & 0o777), 0o600);

    const rollback = spawnSync(process.execPath, [
      join(here, 'stray-drain-install-files.mjs'), 'rollback', result.stdout.trim(),
    ], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
    assert.equal(rollback.status, 0, rollback.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rendered wrapper detaches the exact scheduler command', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stray-drain-nohup-'));
  try {
    const repo = join(root, 'repo');
    const log = join(root, 'logs');
    const bin = join(root, 'bin');
    const marker = join(root, 'receipt.json');
    mkdirSync(join(repo, 'scripts', 'memory-sweep'), { recursive: true });
    mkdirSync(log, { mode: 0o700 });
    mkdirSync(bin);
    symlinkSync(process.execPath, join(bin, 'node'));
    const runtimeBootstrap = join(root, 'bootstrap.mjs');
    writeFileSync(runtimeBootstrap, bootstrapSource, { mode: 0o700 });
    writeFileSync(join(repo, 'scripts', 'memory-sweep', 'stray-drain.mjs'), [
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(marker)}, JSON.stringify({`,
      "  unrelated: process.env.UNRELATED_FLAG ?? 'unset',",
      "  received: Boolean(process.env[['OPENROUTER', 'API', 'KEY'].join('_')]),",
      '}));',
      '',
    ].join('\n'), { mode: 0o600 });
    const rendered = join(root, 'wrapper.zsh');
    writeFileSync(
      rendered,
      wrapper.replaceAll('__STACK_OPS_REPO__', repo)
        .replaceAll('__STACK_OPS_RUNTIME_BOOTSTRAP__', runtimeBootstrap)
        .replaceAll('__STACK_OPS_LOG_DIR__', log),
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
    while (!existsSync(marker) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.deepEqual(JSON.parse(readFileSync(marker, 'utf8')), { unrelated: 'unset', received: true });
    assert.equal((lstatSync(join(log, 'launchd.out')).mode & 0o777), 0o600);
    assert.equal((lstatSync(join(log, 'launchd.err')).mode & 0o777), 0o600);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rendered wrapper reports a bootstrap failure to launchd', () => {
  const root = mkdtempSync(join(tmpdir(), 'stray-drain-nohup-failure-'));
  try {
    const repo = join(root, 'repo');
    const log = join(root, 'logs');
    const bin = join(root, 'bin');
    mkdirSync(join(repo, 'scripts', 'memory-sweep'), { recursive: true });
    mkdirSync(log, { mode: 0o700 });
    mkdirSync(bin);
    symlinkSync(process.execPath, join(bin, 'node'));
    const rendered = join(root, 'wrapper.zsh');
    writeFileSync(
      rendered,
      wrapper.replaceAll('__STACK_OPS_REPO__', repo)
        .replaceAll('__STACK_OPS_RUNTIME_BOOTSTRAP__', join(root, 'missing-bootstrap.mjs'))
        .replaceAll('__STACK_OPS_LOG_DIR__', log),
      { mode: 0o700 },
    );
    chmodSync(rendered, 0o700);
    const result = spawnSync('/bin/zsh', [rendered], {
      env: { HOME: root, PATH: `${bin}:/usr/bin:/bin` },
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0, 'wrapper masked the missing bootstrap as success');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('bootstrap passes the credential through the environment without placing it in child argv', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stray-drain-bootstrap-'));
  try {
    const repo = join(root, 'repo');
    const logDir = join(root, 'logs');
    const receipt = join(root, 'receipt.json');
    const script = join(repo, 'scripts', 'memory-sweep', 'stray-drain.mjs');
    mkdirSync(join(repo, 'scripts', 'memory-sweep'), { recursive: true, mode: 0o700 });
    mkdirSync(logDir, { mode: 0o700 });
    const keyName = ['OPENROUTER', 'API', 'KEY'].join('_');
    const credential = 'credential-fixture';
    writeFileSync(script, [
      "import { writeFileSync } from 'node:fs';",
      `const keyName = ${JSON.stringify(keyName)};`,
      `const credential = ${JSON.stringify(credential)};`,
      `writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({`,
      '  received: process.env[keyName] === credential,',
      '  argvExposed: process.argv.some((value) => value.includes(credential)),',
      '}));',
      '',
    ].join('\n'), { mode: 0o600 });
    const bootstrap = join(here, 'stray-drain-bootstrap.mjs');
    const result = spawnSync(process.execPath, [
      bootstrap,
      '--credential-fd', '0',
      '--node', process.execPath,
      '--repo', repo,
      '--script', script,
      '--log-out', join(logDir, 'launchd.out'),
      '--log-err', join(logDir, 'launchd.err'),
    ], {
      input: credential,
      env: { HOME: root, PATH: process.env.PATH },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const deadline = Date.now() + 2_000;
    while (!existsSync(receipt) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.deepEqual(JSON.parse(readFileSync(receipt, 'utf8')), {
      received: true,
      argvExposed: false,
    });
    assert.equal((lstatSync(join(logDir, 'launchd.out')).mode & 0o777), 0o600);
    assert.equal((lstatSync(join(logDir, 'launchd.err')).mode & 0o777), 0o600);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('installer restores prior files and re-bootstraps the prior job when a replacement bootstrap fails', () => {
  const root = mkdtempSync(join(tmpdir(), 'stray-drain-installer-'));
  try {
    const repo = join(root, 'repo');
    const scripts = join(repo, 'scripts');
    const launchd = join(scripts, 'launchd');
    const home = join(root, 'home');
    const runtimeDir = join(home, '.local', 'stack-ops');
    const plistDir = join(home, 'Library', 'LaunchAgents');
    const logDir = join(home, 'Library', 'Logs', 'stack-ops', 'stray-drain');
    const bin = join(root, 'bin');
    const state = join(root, 'launchctl-state');
    mkdirSync(launchd, { recursive: true });
    mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
    mkdirSync(plistDir, { recursive: true });
    mkdirSync(logDir, { recursive: true, mode: 0o700 });
    mkdirSync(bin);
    writeFileSync(join(scripts, 'install-stray-drain-launchd.zsh'), installer, { mode: 0o700 });
    writeFileSync(join(launchd, 'stack-ops-stray-drain-nohup-wrapper.zsh'), wrapper, { mode: 0o700 });
    writeFileSync(join(launchd, 'stray-drain-bootstrap.mjs'), bootstrapSource, { mode: 0o700 });
    writeFileSync(join(launchd, 'stray-drain-install-files.mjs'), installerHelperSource, { mode: 0o700 });
    writeFileSync(join(launchd, 'com.mitchell.stack-ops.stray-drain.plist'), plist, { mode: 0o600 });
    const runtimeWrapper = join(runtimeDir, 'stray-drain-nohup-wrapper.zsh');
    const installedPlist = join(plistDir, 'com.mitchell.stack-ops.stray-drain.plist');
    writeFileSync(runtimeWrapper, 'prior-wrapper\n', { mode: 0o700 });
    writeFileSync(installedPlist, 'prior-plist\n', { mode: 0o600 });
    writeFileSync(join(bin, 'plutil'), '#!/bin/zsh\nexit 0\n', { mode: 0o700 });
    writeFileSync(join(bin, 'launchctl'), [
      '#!/bin/zsh',
      'state="$TEST_LAUNCHCTL_STATE"',
      'case "$1" in',
      '  print) exit 0 ;;',
      '  bootout) print bootout >> "$state"; exit 0 ;;',
      '  bootstrap)',
      '    print bootstrap >> "$state"',
      '    count=$(grep -c bootstrap "$state")',
      '    [[ "$count" -eq 1 ]] && exit 1',
      '    exit 0',
      '    ;;',
      'esac',
      'exit 1',
      '',
    ].join('\n'), { mode: 0o700 });
    chmodSync(join(bin, 'plutil'), 0o700);
    chmodSync(join(bin, 'launchctl'), 0o700);
    symlinkSync(process.execPath, join(bin, 'node'));
    const result = spawnSync('/bin/zsh', [join(scripts, 'install-stray-drain-launchd.zsh')], {
      env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, TEST_LAUNCHCTL_STATE: state },
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(runtimeWrapper, 'utf8'), 'prior-wrapper\n');
    assert.equal(readFileSync(installedPlist, 'utf8'), 'prior-plist\n');
    assert.equal(readFileSync(state, 'utf8').trim().split('\n').filter((line) => line === 'bootstrap').length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('installer rejects a symlink destination without touching its target or leaving partial files', () => {
  const root = mkdtempSync(join(tmpdir(), 'stray-drain-installer-symlink-'));
  try {
    const repo = join(root, 'repo');
    const launchd = join(repo, 'scripts', 'launchd');
    const home = join(root, 'home');
    const runtimeDir = join(home, '.local', 'stack-ops');
    const plistDir = join(home, 'Library', 'LaunchAgents');
    const logDir = join(home, 'Library', 'Logs', 'stack-ops', 'stray-drain');
    mkdirSync(launchd, { recursive: true });
    mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
    mkdirSync(plistDir, { recursive: true });
    mkdirSync(logDir, { recursive: true, mode: 0o700 });
    chmodSync(runtimeDir, 0o700);
    chmodSync(logDir, 0o700);
    writeFileSync(join(launchd, 'stack-ops-stray-drain-nohup-wrapper.zsh'), wrapper, { mode: 0o700 });
    writeFileSync(join(launchd, 'stray-drain-bootstrap.mjs'), bootstrapSource, { mode: 0o700 });
    writeFileSync(join(launchd, 'com.mitchell.stack-ops.stray-drain.plist'), plist, { mode: 0o600 });
    const sentinel = join(root, 'sentinel');
    writeFileSync(sentinel, 'preserve\n', { mode: 0o700 });
    symlinkSync(sentinel, join(runtimeDir, 'stray-drain-nohup-wrapper.zsh'));
    const result = spawnSync(process.execPath, [join(here, 'stray-drain-install-files.mjs'), 'prepare',
      '--repo', repo,
      '--runtime-dir', runtimeDir,
      '--plist-dir', plistDir,
      '--log-dir', logDir,
    ], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not an exact owned regular file/i);
    assert.equal(readFileSync(sentinel, 'utf8'), 'preserve\n');
    assert.equal(existsSync(join(plistDir, 'com.mitchell.stack-ops.stray-drain.plist')), false);
    assert.equal(existsSync(join(logDir, 'launchd.out')), false);
    assert.equal(existsSync(join(logDir, 'launchd.err')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('installer rejects a dangling symlink destination without replacing the link', () => {
  const root = mkdtempSync(join(tmpdir(), 'stray-drain-installer-dangling-symlink-'));
  try {
    const repo = join(root, 'repo');
    const launchd = join(repo, 'scripts', 'launchd');
    const home = join(root, 'home');
    const runtimeDir = join(home, '.local', 'stack-ops');
    const plistDir = join(home, 'Library', 'LaunchAgents');
    const logDir = join(home, 'Library', 'Logs', 'stack-ops', 'stray-drain');
    mkdirSync(launchd, { recursive: true });
    mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
    mkdirSync(plistDir, { recursive: true });
    mkdirSync(logDir, { recursive: true, mode: 0o700 });
    chmodSync(runtimeDir, 0o700);
    chmodSync(logDir, 0o700);
    writeFileSync(join(launchd, 'stack-ops-stray-drain-nohup-wrapper.zsh'), wrapper, { mode: 0o700 });
    writeFileSync(join(launchd, 'stray-drain-bootstrap.mjs'), bootstrapSource, { mode: 0o700 });
    writeFileSync(join(launchd, 'com.mitchell.stack-ops.stray-drain.plist'), plist, { mode: 0o600 });
    const destination = join(runtimeDir, 'stray-drain-nohup-wrapper.zsh');
    const missingTarget = join(root, 'missing-sentinel');
    symlinkSync(missingTarget, destination);
    const result = spawnSync(process.execPath, [join(here, 'stray-drain-install-files.mjs'), 'prepare',
      '--repo', repo,
      '--runtime-dir', runtimeDir,
      '--plist-dir', plistDir,
      '--log-dir', logDir,
    ], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.equal(lstatSync(destination).isSymbolicLink(), true);
    assert.equal(readlinkSync(destination), missingTarget);
    assert.equal(existsSync(join(plistDir, 'com.mitchell.stack-ops.stray-drain.plist')), false);
    assert.equal(existsSync(join(logDir, 'launchd.out')), false);
    assert.equal(existsSync(join(logDir, 'launchd.err')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('successful installer leaves exact rendered files and private precreated logs', () => {
  const root = mkdtempSync(join(tmpdir(), 'stray-drain-installer-success-'));
  try {
    const repo = join(root, 'repo');
    const scripts = join(repo, 'scripts');
    const launchd = join(scripts, 'launchd');
    const home = join(root, 'home');
    const runtimeDir = join(home, '.local', 'stack-ops');
    const plistDir = join(home, 'Library', 'LaunchAgents');
    const logDir = join(home, 'Library', 'Logs', 'stack-ops', 'stray-drain');
    const bin = join(root, 'bin');
    const state = join(root, 'launchctl-state');
    mkdirSync(launchd, { recursive: true });
    mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
    mkdirSync(plistDir, { recursive: true });
    mkdirSync(logDir, { recursive: true, mode: 0o700 });
    mkdirSync(bin);
    chmodSync(runtimeDir, 0o700);
    chmodSync(logDir, 0o700);
    writeFileSync(join(scripts, 'install-stray-drain-launchd.zsh'), installer, { mode: 0o700 });
    writeFileSync(join(launchd, 'stack-ops-stray-drain-nohup-wrapper.zsh'), wrapper, { mode: 0o700 });
    writeFileSync(join(launchd, 'stray-drain-bootstrap.mjs'), bootstrapSource, { mode: 0o700 });
    writeFileSync(join(launchd, 'stray-drain-install-files.mjs'), installerHelperSource, { mode: 0o700 });
    writeFileSync(join(launchd, 'com.mitchell.stack-ops.stray-drain.plist'), plist, { mode: 0o600 });
    writeFileSync(join(bin, 'plutil'), '#!/bin/zsh\nexit 0\n', { mode: 0o700 });
    writeFileSync(join(bin, 'launchctl'), [
      '#!/bin/zsh',
      '[[ "$1" == "print" ]] && exit 1',
      '[[ "$1" == "bootstrap" ]] && { print bootstrap >> "$TEST_LAUNCHCTL_STATE"; exit 0; }',
      'exit 1',
      '',
    ].join('\n'), { mode: 0o700 });
    chmodSync(join(bin, 'plutil'), 0o700);
    chmodSync(join(bin, 'launchctl'), 0o700);
    symlinkSync(process.execPath, join(bin, 'node'));
    const result = spawnSync('/bin/zsh', [join(scripts, 'install-stray-drain-launchd.zsh')], {
      env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, TEST_LAUNCHCTL_STATE: state },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const installedWrapper = join(runtimeDir, 'stray-drain-nohup-wrapper.zsh');
    const installedBootstrap = join(runtimeDir, 'stray-drain-bootstrap.mjs');
    const installedPlist = join(plistDir, 'com.mitchell.stack-ops.stray-drain.plist');
    assert.equal((lstatSync(installedWrapper).mode & 0o777), 0o700);
    assert.equal((lstatSync(installedBootstrap).mode & 0o777), 0o700);
    assert.equal((lstatSync(installedPlist).mode & 0o777), 0o600);
    assert.equal((lstatSync(join(logDir, 'launchd.out')).mode & 0o777), 0o600);
    assert.equal((lstatSync(join(logDir, 'launchd.err')).mode & 0o777), 0o600);
    assert.doesNotMatch(readFileSync(installedWrapper, 'utf8'), /__STACK_OPS_/);
    assert.doesNotMatch(readFileSync(installedPlist, 'utf8'), /__STACK_OPS_/);
    assert.equal(readFileSync(state, 'utf8').trim(), 'bootstrap');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
