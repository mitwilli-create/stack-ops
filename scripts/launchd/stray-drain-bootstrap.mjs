#!/usr/bin/env node

import { spawn } from 'node:child_process';
import {
  accessSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
} from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const CREDENTIAL_LIMIT = 16_384;

function modeOf(stat) {
  return stat.mode & 0o777;
}

function ownedByCurrentUser(stat) {
  return typeof process.getuid !== 'function' || stat.uid === process.getuid();
}

function openPrivateDirectory(path, label) {
  const before = lstatSync(path);
  if (!before.isDirectory() || before.isSymbolicLink()
      || modeOf(before) !== PRIVATE_DIRECTORY_MODE || !ownedByCurrentUser(before)) {
    throw new Error(`${label} is not an exact private directory (0700)`);
  }
  const fd = openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
  try {
    const after = fstatSync(fd);
    if (after.dev !== before.dev || after.ino !== before.ino || !after.isDirectory()
        || modeOf(after) !== PRIVATE_DIRECTORY_MODE || !ownedByCurrentUser(after)) {
      throw new Error(`${label} changed while it was opened`);
    }
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function openPrivateLog(path) {
  const parentFd = openPrivateDirectory(dirname(path), 'log directory');
  let fd;
  try {
    let before;
    try { before = lstatSync(path); } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (before) {
      if (!before.isFile() || before.isSymbolicLink()
          || modeOf(before) !== PRIVATE_FILE_MODE || !ownedByCurrentUser(before)) {
        throw new Error('launch log is not an exact private regular file (0600)');
      }
      fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0));
      const after = fstatSync(fd);
      if (after.dev !== before.dev || after.ino !== before.ino || !after.isFile()
          || modeOf(after) !== PRIVATE_FILE_MODE || !ownedByCurrentUser(after)) {
        throw new Error('launch log changed while it was opened');
      }
    } else {
      const prior = process.umask(0o077);
      try {
        fd = openSync(
          path,
          constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_EXCL
            | (constants.O_NOFOLLOW ?? 0),
          PRIVATE_FILE_MODE,
        );
      } finally {
        process.umask(prior);
      }
      fchmodSync(fd, PRIVATE_FILE_MODE);
      const after = fstatSync(fd);
      if (!after.isFile() || modeOf(after) !== PRIVATE_FILE_MODE || !ownedByCurrentUser(after)) {
        throw new Error('launch log could not be created as exact private state');
      }
      fsyncSync(fd);
      fsyncSync(parentFd);
    }
    return fd;
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    throw error;
  } finally {
    closeSync(parentFd);
  }
}

function parseArgs(argv) {
  const allowed = new Set(['--credential-fd', '--node', '--repo', '--script', '--log-out', '--log-err']);
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(flag) || value === undefined || values[flag] !== undefined) {
      throw new Error('invalid bootstrap arguments');
    }
    values[flag] = value;
  }
  if (Object.keys(values).length !== allowed.size) throw new Error('missing bootstrap arguments');
  const credentialFd = Number(values['--credential-fd']);
  if (!Number.isSafeInteger(credentialFd) || credentialFd < 0) throw new Error('invalid credential descriptor');
  for (const flag of ['--node', '--repo', '--script', '--log-out', '--log-err']) {
    if (!isAbsolute(values[flag]) || /[\r\n\0]/.test(values[flag])) throw new Error(`invalid ${flag.slice(2)} path`);
  }
  return { credentialFd, ...Object.fromEntries([...allowed].slice(1).map((flag) => [flag.slice(2), values[flag]])) };
}

function readCredential(fd) {
  const chunks = [];
  let total = 0;
  while (true) {
    const buffer = Buffer.alloc(Math.min(4_096, CREDENTIAL_LIMIT + 1 - total));
    const count = readSync(fd, buffer, 0, buffer.length, null);
    if (count === 0) break;
    total += count;
    if (total > CREDENTIAL_LIMIT) throw new Error('credential exceeds the allowed bound');
    chunks.push(buffer.subarray(0, count));
  }
  const value = Buffer.concat(chunks, total).toString('utf8');
  if (/[\r\n\0]/.test(value)) throw new Error('credential contains an unsafe character');
  return value;
}

function cleanChildEnvironment(credential) {
  const allowed = ['HOME', 'USER', 'LOGNAME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE'];
  const env = Object.fromEntries(allowed.filter((key) => process.env[key] !== undefined)
    .map((key) => [key, process.env[key]]));
  if (credential) env[['OPENROUTER', 'API', 'KEY'].join('_')] = credential;
  return env;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  accessSync(options.node, constants.X_OK);
  const repo = lstatSync(options.repo);
  if (!repo.isDirectory() || repo.isSymbolicLink() || !ownedByCurrentUser(repo)) {
    throw new Error('coordinator repository is not a safe owned directory');
  }
  if (options.script !== join(options.repo, 'scripts', 'memory-sweep', 'stray-drain.mjs')) {
    throw new Error('coordinator script path is not the exact scheduler entrypoint');
  }
  const script = lstatSync(options.script);
  if (!script.isFile() || script.isSymbolicLink()) throw new Error('coordinator script is not a regular file');
  const credential = readCredential(options.credentialFd);
  const outFd = openPrivateLog(options['log-out']);
  let errFd;
  try {
    errFd = openPrivateLog(options['log-err']);
    const child = spawn(options.node, [options.script], {
      cwd: options.repo,
      detached: true,
      env: cleanChildEnvironment(credential),
      stdio: ['ignore', outFd, errFd],
    });
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    if (!Number.isSafeInteger(child.pid) || child.pid <= 0) throw new Error('coordinator process did not start');
    child.unref();
  } finally {
    closeSync(outFd);
    if (errFd !== undefined) closeSync(errFd);
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(`stray-drain bootstrap failed: ${error.message}\n`);
  process.exitCode = 1;
}
