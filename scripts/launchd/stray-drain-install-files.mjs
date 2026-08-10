#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const EXECUTABLE_FILE_MODE = 0o700;

function modeOf(stat) {
  return stat.mode & 0o777;
}

function ownedByCurrentUser(stat) {
  return typeof process.getuid !== 'function' || stat.uid === process.getuid();
}

function pathEntryExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function withPrivateUmask(action) {
  const prior = process.umask(0o077);
  try { return action(); } finally { process.umask(prior); }
}

function writeAll(fd, value) {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(value);
  let offset = 0;
  while (offset < body.length) {
    const written = writeSync(fd, body, offset, body.length - offset);
    if (written <= 0) throw new Error('installation write made no progress');
    offset += written;
  }
}

function openDirectory(path, label, exactMode = null) {
  const before = lstatSync(path);
  if (!before.isDirectory() || before.isSymbolicLink() || !ownedByCurrentUser(before)
      || (modeOf(before) & 0o022) !== 0
      || (exactMode !== null && modeOf(before) !== exactMode)) {
    throw new Error(`${label} is not a safe owned directory${exactMode === null ? '' : ` (${exactMode.toString(8)})`}`);
  }
  const fd = openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
  try {
    const after = fstatSync(fd);
    if (after.dev !== before.dev || after.ino !== before.ino || !after.isDirectory()
        || !ownedByCurrentUser(after) || (modeOf(after) & 0o022) !== 0
        || (exactMode !== null && modeOf(after) !== exactMode)) {
      throw new Error(`${label} changed while it was opened`);
    }
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function ensurePrivateDirectory(path, label) {
  if (!pathEntryExists(path)) withPrivateUmask(() => mkdirSync(path, { mode: PRIVATE_DIRECTORY_MODE }));
  const fd = openDirectory(path, label, PRIVATE_DIRECTORY_MODE);
  closeSync(fd);
}

function openRegular(path, label, expectedMode, flags = constants.O_RDONLY) {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || !ownedByCurrentUser(before)
      || modeOf(before) !== expectedMode) {
    throw new Error(`${label} is not an exact owned regular file (${expectedMode.toString(8)})`);
  }
  const fd = openSync(path, flags | (constants.O_NOFOLLOW ?? 0));
  try {
    const after = fstatSync(fd);
    if (after.dev !== before.dev || after.ino !== before.ino || !after.isFile()
        || !ownedByCurrentUser(after) || modeOf(after) !== expectedMode) {
      throw new Error(`${label} changed while it was opened`);
    }
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function readRegular(path, label, expectedMode) {
  const fd = openRegular(path, label, expectedMode);
  try { return readFileSync(fd, 'utf8'); } finally { closeSync(fd); }
}

function readSource(path, label) {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || !ownedByCurrentUser(before)) {
    throw new Error(`${label} is not a safe regular file`);
  }
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const after = fstatSync(fd);
    if (after.dev !== before.dev || after.ino !== before.ino || !after.isFile()) {
      throw new Error(`${label} changed while it was opened`);
    }
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}

function fsyncParent(path) {
  const fd = openDirectory(dirname(path), 'installation parent');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function atomicWrite(path, body, mode, label) {
  const parentFd = openDirectory(dirname(path), `${label} parent`);
  const temporary = join(dirname(path), `.${basename(path)}.tmp-${randomUUID()}`);
  let fd;
  try {
    fd = withPrivateUmask(() => openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      mode,
    ));
    fchmodSync(fd, mode);
    writeAll(fd, body);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    const verifyFd = openRegular(temporary, `${label} temporary file`, mode);
    closeSync(verifyFd);
    renameSync(temporary, path);
    fsyncSync(parentFd);
    const installedFd = openRegular(path, label, mode);
    closeSync(installedFd);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); } catch (cleanupError) {
      if (cleanupError?.code !== 'ENOENT') error.cleanupFailure = cleanupError.code ?? cleanupError.message;
    }
    throw error;
  } finally {
    closeSync(parentFd);
  }
}

function createEmptyPrivateFile(path, label, entries) {
  if (pathEntryExists(path)) {
    const fd = openRegular(path, label, PRIVATE_FILE_MODE, constants.O_WRONLY | constants.O_APPEND);
    closeSync(fd);
    return;
  }
  atomicWrite(path, '', PRIVATE_FILE_MODE, label);
  entries.push({ path, mode: PRIVATE_FILE_MODE, backup: null });
}

function replaceWithBackup(path, body, mode, label, entries) {
  const entry = { path, mode, backup: null };
  if (pathEntryExists(path)) {
    const fd = openRegular(path, `${label} prior file`, mode);
    closeSync(fd);
    entry.backup = join(dirname(path), `.${basename(path)}.rollback-${randomUUID()}`);
    linkSync(path, entry.backup);
    fsyncParent(path);
    const backupFd = openRegular(entry.backup, `${label} recovery file`, mode);
    closeSync(backupFd);
  }
  entries.push(entry);
  atomicWrite(path, body, mode, label);
}

function rollbackEntries(entries) {
  const failures = [];
  for (const entry of [...entries].reverse()) {
    try {
      if (entry.backup) {
        const backupFd = openRegular(entry.backup, 'installation recovery file', entry.mode);
        closeSync(backupFd);
        renameSync(entry.backup, entry.path);
        fsyncParent(entry.path);
        const restoredFd = openRegular(entry.path, 'restored installation file', entry.mode);
        closeSync(restoredFd);
      } else if (pathEntryExists(entry.path)) {
        const installedFd = openRegular(entry.path, 'replacement installation file', entry.mode);
        closeSync(installedFd);
        unlinkSync(entry.path);
        fsyncParent(entry.path);
      }
    } catch (error) {
      failures.push(error.code ?? error.message);
    }
  }
  if (failures.length) throw new Error(`installation rollback failed for ${failures.length} file(s)`);
}

function parseFlags(argv) {
  const allowed = new Set(['--repo', '--runtime-dir', '--plist-dir', '--log-dir']);
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(flag) || value === undefined || values[flag] !== undefined) {
      throw new Error('invalid installer helper arguments');
    }
    values[flag] = value;
  }
  for (const [flag, value] of Object.entries(values)) {
    if (!isAbsolute(value) || /[\r\n\0]/.test(value)) throw new Error(`invalid ${flag.slice(2)} path`);
  }
  return values;
}

function readTransaction(path) {
  const home = process.env.HOME;
  if (!home || !isAbsolute(home) || /[\r\n\0]/.test(home)) throw new Error('installer HOME is invalid');
  const runtimeDir = join(home, '.local', 'stack-ops');
  if (dirname(path) !== runtimeDir || !/^\.stray-drain-install-[0-9a-f-]+\.json$/i.test(basename(path))) {
    throw new Error('installation transaction path is outside the runtime directory');
  }
  const transaction = JSON.parse(readRegular(path, 'installation transaction', PRIVATE_FILE_MODE));
  const allowed = new Map([
    [join(runtimeDir, 'stray-drain-nohup-wrapper.zsh'), EXECUTABLE_FILE_MODE],
    [join(runtimeDir, 'stray-drain-bootstrap.mjs'), EXECUTABLE_FILE_MODE],
    [join(home, 'Library', 'LaunchAgents', 'com.mitchell.stack-ops.stray-drain.plist'), PRIVATE_FILE_MODE],
    [join(home, 'Library', 'Logs', 'stack-ops', 'stray-drain', 'launchd.out'), PRIVATE_FILE_MODE],
    [join(home, 'Library', 'Logs', 'stack-ops', 'stray-drain', 'launchd.err'), PRIVATE_FILE_MODE],
  ]);
  if (!transaction || transaction.schemaVersion !== 1 || !Array.isArray(transaction.entries)
      || !transaction.entries.every((entry) => entry && isAbsolute(entry.path)
        && allowed.get(entry.path) === entry.mode
        && (entry.backup === null || (dirname(entry.backup) === dirname(entry.path)
          && new RegExp(`^\\.${basename(entry.path).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.rollback-[0-9a-f-]+$`, 'i')
            .test(basename(entry.backup)))))) {
    throw new Error('installation transaction is invalid');
  }
  const paths = transaction.entries.map((entry) => entry.path);
  if (new Set(paths).size !== paths.length
      || ![...allowed.keys()].slice(0, 3).every((required) => paths.includes(required))) {
    throw new Error('installation transaction paths are incomplete or duplicated');
  }
  return transaction;
}

function prepare(values) {
  for (const required of ['--repo', '--runtime-dir', '--plist-dir', '--log-dir']) {
    if (!values[required]) throw new Error(`missing ${required}`);
  }
  const repo = values['--repo'];
  const runtimeDir = values['--runtime-dir'];
  const plistDir = values['--plist-dir'];
  const logDir = values['--log-dir'];
  const home = process.env.HOME;
  if (!home || runtimeDir !== join(home, '.local', 'stack-ops')
      || plistDir !== join(home, 'Library', 'LaunchAgents')
      || logDir !== join(home, 'Library', 'Logs', 'stack-ops', 'stray-drain')) {
    throw new Error('installation paths do not match the exact HOME-scoped targets');
  }
  ensurePrivateDirectory(runtimeDir, 'runtime directory');
  ensurePrivateDirectory(logDir, 'log directory');
  const plistDirFd = openDirectory(plistDir, 'LaunchAgents directory');
  closeSync(plistDirFd);
  const entries = [];
  const runtimeWrapper = join(runtimeDir, 'stray-drain-nohup-wrapper.zsh');
  const runtimeBootstrap = join(runtimeDir, 'stray-drain-bootstrap.mjs');
  const plistPath = join(plistDir, 'com.mitchell.stack-ops.stray-drain.plist');
  let transactionPath;
  try {
    createEmptyPrivateFile(join(logDir, 'launchd.out'), 'launch standard output log', entries);
    createEmptyPrivateFile(join(logDir, 'launchd.err'), 'launch standard error log', entries);
    const wrapper = readSource(
      join(repo, 'scripts', 'launchd', 'stack-ops-stray-drain-nohup-wrapper.zsh'),
      'wrapper source',
    ).replaceAll('__STACK_OPS_REPO__', repo)
      .replaceAll('__STACK_OPS_RUNTIME_BOOTSTRAP__', runtimeBootstrap)
      .replaceAll('__STACK_OPS_LOG_DIR__', logDir);
    const bootstrap = readSource(
      join(repo, 'scripts', 'launchd', 'stray-drain-bootstrap.mjs'),
      'bootstrap source',
    );
    const plist = readSource(
      join(repo, 'scripts', 'launchd', 'com.mitchell.stack-ops.stray-drain.plist'),
      'property list source',
    ).replaceAll('__STACK_OPS_RUNTIME_WRAPPER__', runtimeWrapper)
      .replaceAll('__STACK_OPS_HOME__', home)
      .replaceAll('__STACK_OPS_LOG_DIR__', logDir);
    replaceWithBackup(runtimeWrapper, wrapper, EXECUTABLE_FILE_MODE, 'runtime wrapper', entries);
    replaceWithBackup(runtimeBootstrap, bootstrap, EXECUTABLE_FILE_MODE, 'runtime bootstrap', entries);
    replaceWithBackup(plistPath, plist, PRIVATE_FILE_MODE, 'installed property list', entries);
    transactionPath = join(runtimeDir, `.stray-drain-install-${randomUUID()}.json`);
    atomicWrite(transactionPath, `${JSON.stringify({ schemaVersion: 1, entries })}\n`, PRIVATE_FILE_MODE, 'installation transaction');
  } catch (error) {
    rollbackEntries(entries);
    throw error;
  }
  process.stdout.write(`${transactionPath}\n`);
}

function rollback(transactionPath) {
  const transaction = readTransaction(transactionPath);
  rollbackEntries(transaction.entries);
  unlinkSync(transactionPath);
  fsyncParent(transactionPath);
}

function finalize(transactionPath) {
  const transaction = readTransaction(transactionPath);
  for (const entry of transaction.entries) {
    if (!entry.backup) continue;
    const fd = openRegular(entry.backup, 'installation recovery file', entry.mode);
    closeSync(fd);
    unlinkSync(entry.backup);
    fsyncParent(entry.backup);
  }
  unlinkSync(transactionPath);
  fsyncParent(transactionPath);
}

try {
  const [operation, ...argv] = process.argv.slice(2);
  if (operation === 'prepare') prepare(parseFlags(argv));
  else if (operation === 'rollback' && argv.length === 1 && isAbsolute(argv[0])) rollback(argv[0]);
  else if (operation === 'finalize' && argv.length === 1 && isAbsolute(argv[0])) finalize(argv[0]);
  else throw new Error('invalid installer helper operation');
} catch (error) {
  process.stderr.write(`stray-drain installer helper failed: ${error.message}\n`);
  process.exitCode = 1;
}
