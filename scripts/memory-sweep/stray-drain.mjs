#!/usr/bin/env node
/**
 * Scheduled, bounded transcript drain coordinator.
 *
 * Discovery reads metadata only. The Claude-config drainer owns claim-before-read,
 * credential scanning, provider routing, and append-only placement. This wrapper
 * validates one metadata-only receipt per selected transcript and commits only the
 * exact records returned by this run under the shared vault lock.
 */

import { spawnSync } from 'node:child_process';
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { discoverCandidates } from './stray-discovery.mjs';

const HOME = homedir();
const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG = join(HERE, 'config.json');
const FORBIDDEN_RECEIPT_KEYS = new Set(['prompt', 'text', 'body', 'content', 'stdout', 'stderr']);
const TERMINAL_NO_RECORD = new Set([
  'proven_duplicate',
  'skipped_empty',
  'skipped_thin',
  'unsupported_source',
]);
const RETRYABLE = new Set([
  'live_owned',
  'parse_incomplete',
  'privacy_refused',
  'provider_failed',
  'unroutable',
  'claim_error',
  'orphan_claim',
]);
const PROGRESS_STATUSES = new Set(['mined', ...TERMINAL_NO_RECORD, ...RETRYABLE]);
const BASE_PROGRESS_KEYS = ['observedAt', 'runId', 'sourcePath', 'status', 'transcriptId'];
const OPTIONAL_PROGRESS_KEYS = new Set([
  'accountType',
  'chars',
  'chunks',
  'detailCode',
  'durationMs',
  'failureReason',
  'project',
  'provider',
  'providerAttempts',
  'recordPath',
  'recordSha256',
  'requestedSlot',
  'resolvedModel',
  'sourceSha256',
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function integer(value, name, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`invalid strayDrain.${name}: expected integer ${min}..${max}`);
  }
  return value;
}

export function validateStrayDrainConfig(input) {
  const c = { ...input };
  c.maxPerRun = integer(c.maxPerRun, 'maxPerRun', 1, 400);
  c.concurrency = integer(c.concurrency, 'concurrency', 1, 64);
  c.subscriptionConcurrency = integer(c.subscriptionConcurrency ?? 4, 'subscriptionConcurrency', 1, 4);
  c.quiescenceMinutes = integer(c.quiescenceMinutes, 'quiescenceMinutes', 45, 10_080);
  c.perProviderTimeoutMs = integer(c.perProviderTimeoutMs ?? 240_000, 'perProviderTimeoutMs', 1_000, 240_000);
  c.perTranscriptDeadlineMs = integer(c.perTranscriptDeadlineMs ?? 900_000, 'perTranscriptDeadlineMs', 1_000, 900_000);
  c.globalDeadlineMs = integer(c.globalDeadlineMs ?? 3_300_000, 'globalDeadlineMs', 10_000, 7_200_000);
  c.maxAttemptsPerProvider = integer(c.maxAttemptsPerProvider ?? 1, 'maxAttemptsPerProvider', 1, 1);
  c.maxSourceBytes = integer(c.maxSourceBytes ?? 16_000_000, 'maxSourceBytes', 1_024, 16_000_000);
  c.chunkChars = integer(c.chunkChars ?? 48_000, 'chunkChars', 2_000, 100_000);
  c.maxChunksPerTranscript = integer(c.maxChunksPerTranscript ?? 48, 'maxChunksPerTranscript', 1, 48);
  return c;
}

export function parseCoordinatorArgs(argv, maxPerRun) {
  if (!Array.isArray(argv) || !argv.every((value) => typeof value === 'string')) {
    throw new Error('coordinator arguments must be strings');
  }
  integer(maxPerRun, 'maxPerRun', 1, 400);
  let dryRun = false;
  let limitValue = null;
  let idsFile = null;
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!['--dry-run', '--limit', '--ids-file'].includes(flag)) {
      throw new Error(`unknown or positional coordinator argument: ${flag}`);
    }
    if (seen.has(flag)) throw new Error(`duplicate coordinator argument: ${flag}`);
    seen.add(flag);
    if (flag === '--dry-run') {
      dryRun = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`missing value for coordinator argument ${flag}`);
    }
    index += 1;
    if (flag === '--limit') limitValue = value;
    else idsFile = value;
  }
  if (limitValue !== null && idsFile !== null) {
    throw new Error('--limit conflicts with --ids-file');
  }
  let requestedLimit = maxPerRun;
  if (limitValue !== null) {
    if (!/^[1-9][0-9]*$/.test(limitValue)) throw new Error('invalid coordinator limit');
    requestedLimit = integer(Number(limitValue), 'limit', 1, maxPerRun);
  }
  return { dryRun, idsFile, requestedLimit };
}

export function readRequestedIds(path, maxIds) {
  integer(maxIds, 'selectorLimit', 1, 400);
  if (typeof path !== 'string' || !isAbsolute(path) || /[\r\n\0]/.test(path)) {
    throw new Error('requested identifier file path is invalid');
  }
  privateDirectory(dirname(path), 'requested identifier file parent');
  const { fd, stat: before } = openPrivateRegular(path, 'requested identifier file');
  let raw;
  try {
    if (before.size > maxIds * 37) throw new Error('requested identifier file exceeds selector limit');
    raw = readFileSync(fd, 'utf8');
    const after = fstatSync(fd);
    assertSameObject(before, after, 'requested identifier file');
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw new Error('requested identifier file changed while it was read');
    }
  } finally {
    closeSync(fd);
  }
  if (!raw || /[\r\0]/.test(raw)) throw new Error('requested identifier file is empty or malformed');
  const lines = raw.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (!lines.length || lines.length > maxIds || lines.some((id) => !id)) {
    throw new Error('requested identifier count is outside the selector limit');
  }
  const seen = new Set();
  for (const id of lines) {
    if (id !== id.trim() || id !== id.toLowerCase() || !UUID_PATTERN.test(id)) {
      throw new Error('requested identifier file contains a non-canonical transcript identifier');
    }
    if (seen.has(id)) throw new Error(`duplicate requested transcript identifier: ${id}`);
    seen.add(id);
  }
  return lines;
}

export function selectRequestedCandidates(candidates, requestedIds) {
  if (!Array.isArray(candidates) || !Array.isArray(requestedIds) || !requestedIds.length) {
    throw new Error('requested candidate selection is invalid');
  }
  const byId = new Map();
  for (const candidate of candidates) {
    if (!candidate || typeof candidate.id !== 'string') throw new Error('candidate inventory is invalid');
    if (byId.has(candidate.id)) throw new Error(`ambiguous candidate inventory for ${candidate.id}`);
    byId.set(candidate.id, candidate);
  }
  const selected = [];
  const seen = new Set();
  for (const id of requestedIds) {
    if (seen.has(id)) throw new Error(`duplicate requested transcript identifier: ${id}`);
    seen.add(id);
    const candidate = byId.get(id);
    if (!candidate) throw new Error(`requested transcript is not currently eligible: ${id}`);
    selected.push(candidate);
  }
  return selected;
}

export function assertRequestedSelectionStable(beforeIds, afterIds, beforeCandidates, afterCandidates) {
  if (!isDeepStrictEqual(afterIds, beforeIds)) {
    throw new Error('requested identifier file changed during startup recovery');
  }
  if (!isDeepStrictEqual(afterCandidates, beforeCandidates)) {
    throw new Error('requested transcript membership changed during startup recovery');
  }
}

export function buildDrainerArgs({
  drainer,
  listFile,
  progress,
  dispositions,
  placementJournal,
  selectedCount,
  bounds,
  dryRun = false,
}) {
  const args = [
    drainer,
    '--list', listFile,
    '--limit', String(selectedCount),
    '--concurrency', String(bounds.concurrency),
    '--subscription-concurrency', String(bounds.subscriptionConcurrency),
    '--out', progress,
    '--dispositions', dispositions,
    '--placement-journal', placementJournal,
    '--quiescence-minutes', String(bounds.quiescenceMinutes),
    '--provider-timeout-ms', String(bounds.perProviderTimeoutMs),
    '--transcript-deadline-ms', String(bounds.perTranscriptDeadlineMs),
    '--max-attempts-per-provider', String(bounds.maxAttemptsPerProvider),
    '--max-source-bytes', String(bounds.maxSourceBytes),
    '--chunk-chars', String(bounds.chunkChars),
    '--max-chunks', String(bounds.maxChunksPerTranscript),
  ];
  if (dryRun) args.push('--dry-run');
  return args;
}

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

function modeOf(stat) {
  return stat.mode & 0o777;
}

function assertOwner(stat, label) {
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`${label} is not owned by the current user`);
  }
}

function assertSameObject(before, after, label) {
  if (before.dev !== after.dev || before.ino !== after.ino) {
    throw new Error(`${label} changed while it was opened`);
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
    if (written <= 0) throw new Error('private state write made no progress');
    offset += written;
  }
}

function openPrivateDirectory(path, label) {
  let before;
  try { before = lstatSync(path); }
  catch (error) { throw new Error(`${label} is unavailable: ${error.code ?? error.message}`); }
  if (!before.isDirectory() || before.isSymbolicLink() || modeOf(before) !== PRIVATE_DIRECTORY_MODE) {
    throw new Error(`${label} is not an exact private directory (0700)`);
  }
  assertOwner(before, label);
  const fd = openSync(
    path,
    constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const after = fstatSync(fd);
    assertSameObject(before, after, label);
    if (!after.isDirectory() || modeOf(after) !== PRIVATE_DIRECTORY_MODE) {
      throw new Error(`${label} is not an exact private directory (0700)`);
    }
    assertOwner(after, label);
    return { fd, stat: after };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function privateDirectory(path, label) {
  const { fd, stat } = openPrivateDirectory(path, label);
  closeSync(fd);
  return stat;
}

function ensurePrivateDirectory(path, label) {
  if (!existsSync(path)) {
    withPrivateUmask(() => mkdirSync(path, { mode: PRIVATE_DIRECTORY_MODE }));
  }
  return privateDirectory(path, label);
}

function ensurePrivateDirectoryTree(root, relativePath, label) {
  privateDirectory(root, `${label} root`);
  const parts = relativePath.split(sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    if (part === '.' || part === '..') throw new Error(`${label} contains an unsafe path component`);
    current = join(current, part);
    ensurePrivateDirectory(current, label);
  }
  return current;
}

function openPrivateRegular(path, label, flags = constants.O_RDONLY) {
  let before;
  try { before = lstatSync(path); }
  catch (error) { throw new Error(`${label} is unavailable: ${error.code ?? error.message}`); }
  if (!before.isFile() || before.isSymbolicLink() || modeOf(before) !== PRIVATE_FILE_MODE) {
    throw new Error(`${label} is not an exact private regular file (0600)`);
  }
  assertOwner(before, label);
  const fd = openSync(path, flags | (constants.O_NOFOLLOW ?? 0));
  try {
    const after = fstatSync(fd);
    assertSameObject(before, after, label);
    if (!after.isFile() || modeOf(after) !== PRIVATE_FILE_MODE) {
      throw new Error(`${label} is not an exact private regular file (0600)`);
    }
    assertOwner(after, label);
    return { fd, stat: after };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function readPrivate(path, label, encoding = 'utf8') {
  const { fd } = openPrivateRegular(path, label);
  try { return encoding === null ? readFileSync(fd) : readFileSync(fd, encoding); }
  finally { closeSync(fd); }
}

function writeNewPrivateDurable(path, body) {
  const parent = dirname(path);
  privateDirectory(parent, 'private state parent');
  const temporary = join(parent, `.${basename(path)}.tmp-${randomUUID()}`);
  const fd = withPrivateUmask(() => openSync(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    PRIVATE_FILE_MODE,
  ));
  try {
    fchmodSync(fd, PRIVATE_FILE_MODE);
    if (body) writeAll(fd, body);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  privateRegular(temporary, 'new private state temporary file');
  try {
    linkSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  fsyncDirectory(parent);
  privateRegular(path, 'new private state');
}

function fsyncDirectory(directory) {
  const { fd } = openPrivateDirectory(directory, 'private state parent');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export function createRunArtifacts(logDir, selected, ownership = {}) {
  if (selected.some((row) => typeof row.path !== 'string' || !isAbsolute(row.path) || /[\r\n\0]/.test(row.path))) {
    throw new Error('source list contains an unsafe path');
  }
  privateDirectory(logDir, 'log directory');
  const runDirectory = withPrivateUmask(() => mkdtempSync(join(logDir, 'run-')));
  privateDirectory(runDirectory, 'run directory');
  const listFile = join(runDirectory, 'sources.txt');
  const progress = join(runDirectory, 'progress.jsonl');
  const placementJournal = join(runDirectory, 'placement-journal.jsonl');
  const transactionOwner = join(runDirectory, 'transaction-owner.json');
  writeNewPrivateDurable(listFile, selected.map((row) => row.path).join('\n') + '\n');
  writeNewPrivateDurable(progress, '');
  writeNewPrivateDurable(placementJournal, '');
  writeNewPrivateDurable(transactionOwner, `${JSON.stringify({
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    ownerPid: process.pid,
    vaultHead: ownership.vaultHead ?? null,
    sources: selected.map((row) => ({ transcriptId: row.id ?? basename(row.path, '.jsonl'), sourcePath: row.path })),
  })}\n`);
  fsyncDirectory(runDirectory);
  fsyncDirectory(logDir);
  return {
    runDirectory,
    runId: basename(runDirectory),
    listFile,
    progress,
    placementJournal,
    transactionOwner,
  };
}

function readLedgerStrict(path) {
  if (!existsSync(path)) return new Set();
  let raw;
  try {
    privateDirectory(dirname(path), 'ledger parent');
    raw = readPrivate(path, 'ledger');
  } catch (error) {
    throw new Error(`ledger read failed at ${path}: ${error.code ?? error.message}`);
  }
  const ids = new Set();
  for (const line of raw.split('\n')) {
    const id = line.trim();
    if (!id) continue;
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(id)) throw new Error('ledger contains an invalid identifier');
    ids.add(id);
  }
  return ids;
}

function contained(path, root) {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function hasForbiddenKey(value) {
  if (Array.isArray(value)) return value.some(hasForbiddenKey);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => FORBIDDEN_RECEIPT_KEYS.has(key) || hasForbiddenKey(child));
}

export function parseProgress(raw, expected) {
  const rows = [];
  for (const [index, line] of raw.split('\n').entries()) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); }
    catch { throw new Error(`malformed progress row ${index + 1}`); }
    if (hasForbiddenKey(row)) throw new Error(`forbidden content key in progress row ${index + 1}`);
    if (!row || Array.isArray(row) || typeof row !== 'object'
        || typeof row.transcriptId !== 'string' || typeof row.sourcePath !== 'string'
        || typeof row.status !== 'string' || typeof row.observedAt !== 'string'
        || typeof row.runId !== 'string') {
      throw new Error(`progress row ${index + 1} is missing required metadata`);
    }
    if (!PROGRESS_STATUSES.has(row.status)) {
      throw new Error(`invalid progress status in row ${index + 1}`);
    }
    const observedAt = Date.parse(row.observedAt);
    if (!Number.isFinite(observedAt) || new Date(observedAt).toISOString() !== row.observedAt) {
      throw new Error(`invalid observedAt in progress row ${index + 1}`);
    }
    if (!UUID_PATTERN.test(row.runId)) throw new Error(`invalid runId in progress row ${index + 1}`);
    const allowedKeys = new Set([...BASE_PROGRESS_KEYS, ...OPTIONAL_PROGRESS_KEYS]);
    if (Object.keys(row).some((key) => !allowedKeys.has(key))) {
      throw new Error(`invalid progress schema in row ${index + 1}`);
    }
    for (const key of ['chars', 'chunks', 'durationMs']) {
      if (Object.hasOwn(row, key) && (!Number.isSafeInteger(row[key]) || row[key] < 0)) {
        throw new Error(`invalid ${key} in progress row ${index + 1}`);
      }
    }
    for (const key of ['sourceSha256', 'recordSha256']) {
      if (Object.hasOwn(row, key) && !/^[a-f0-9]{64}$/.test(row[key])) {
        throw new Error(`invalid ${key} in progress row ${index + 1}`);
      }
    }
    for (const key of ['project', 'detailCode', 'requestedSlot', 'provider', 'accountType']) {
      if (Object.hasOwn(row, key) && (typeof row[key] !== 'string' || row[key].length > 256)) {
        throw new Error(`invalid ${key} in progress row ${index + 1}`);
      }
    }
    for (const key of ['resolvedModel', 'failureReason']) {
      if (Object.hasOwn(row, key) && row[key] !== null
          && (typeof row[key] !== 'string' || row[key].length > 256)) {
        throw new Error(`invalid ${key} in progress row ${index + 1}`);
      }
    }
    if (Object.hasOwn(row, 'providerAttempts')) {
      if (!Array.isArray(row.providerAttempts) || row.providerAttempts.length > 144) {
        throw new Error(`invalid providerAttempts in progress row ${index + 1}`);
      }
      const keys = ['accountType', 'engine', 'failureReason', 'outcome', 'provider', 'requestedSlot', 'resolvedModel'];
      for (const attempt of row.providerAttempts) {
        if (!attempt || Array.isArray(attempt) || typeof attempt !== 'object'
            || Object.keys(attempt).sort().join(',') !== keys.sort().join(',')) {
          throw new Error(`invalid providerAttempts in progress row ${index + 1}`);
        }
        for (const key of ['engine', 'requestedSlot', 'provider', 'accountType', 'outcome']) {
          if (typeof attempt[key] !== 'string' || attempt[key].length > 256) {
            throw new Error(`invalid providerAttempts in progress row ${index + 1}`);
          }
        }
        for (const key of ['resolvedModel', 'failureReason']) {
          if (attempt[key] !== null && (typeof attempt[key] !== 'string' || attempt[key].length > 256)) {
            throw new Error(`invalid providerAttempts in progress row ${index + 1}`);
          }
        }
      }
    }
    if (row.status === 'mined'
        && (typeof row.recordPath !== 'string' || !isAbsolute(row.recordPath)
          || !/^[a-f0-9]{64}$/.test(row.recordSha256)
          || !/^[a-f0-9]{64}$/.test(row.sourceSha256))) {
      throw new Error(`mined progress row ${index + 1} requires source and record proof`);
    }
    if (row.status === 'mined'
        && (typeof row.requestedSlot !== 'string' || !row.requestedSlot
          || typeof row.provider !== 'string' || !row.provider
          || typeof row.accountType !== 'string' || !row.accountType
          || !Array.isArray(row.providerAttempts) || !row.providerAttempts.length)) {
      throw new Error(`mined progress row ${index + 1} requires provider proof`);
    }
    if (row.status === 'proven_duplicate'
        && (!/^[a-f0-9]{64}$/.test(row.sourceSha256)
          || typeof row.recordPath !== 'string' || !isAbsolute(row.recordPath)
          || !/^[a-f0-9]{64}$/.test(row.recordSha256))) {
      throw new Error(`proven_duplicate progress row ${index + 1} requires source and record proof`);
    }
    if (row.status !== 'mined' && row.status !== 'proven_duplicate'
        && (Object.hasOwn(row, 'recordPath') || Object.hasOwn(row, 'recordSha256'))) {
      throw new Error(`non-mined progress row ${index + 1} cannot carry record proof`);
    }
    rows.push(row);
  }
  const seen = new Set();
  for (const row of rows) {
    if (seen.has(row.transcriptId)) throw new Error(`duplicate progress id ${row.transcriptId}`);
    seen.add(row.transcriptId);
  }
  if (expected) {
    const byId = new Map(expected.map((row) => [row.id, row.path]));
    for (const row of rows) {
      if (byId.get(row.transcriptId) !== row.sourcePath) {
        throw new Error(`progress source mismatch for ${row.transcriptId}`);
      }
    }
    if (rows.length !== expected.length) {
      throw new Error(`progress count mismatch: expected ${expected.length}, received ${rows.length}`);
    }
  }
  return rows;
}

function parseEvidenceLines(raw, label) {
  const rows = [];
  const issues = [];
  for (const [index, line] of raw.split('\n').entries()) {
    if (!line.trim()) continue;
    try {
      rows.push(parseProgress(`${line}\n`, null)[0]);
    } catch {
      issues.push({ kind: `malformed_${label}`, line: index + 1 });
    }
  }
  return { rows, issues };
}

function parsePlacementJournalEvidence(raw) {
  const placed = [];
  const intents = [];
  const claimIntents = [];
  const claimAcquired = [];
  const issues = [];
  const intentKeys = [
    'accountType', 'chars', 'chunks', 'desiredRecordPath', 'event', 'failureReason',
    'observedAt', 'project', 'provider', 'providerAttempts', 'recordSha256',
    'requestedSlot', 'resolvedModel', 'runId', 'sourcePath', 'sourceSha256', 'transcriptId',
  ];
  const claimKeys = ['event', 'observedAt', 'ownerPid', 'runId', 'sourcePath', 'transcriptId'];
  const precedingClaims = [];
  for (const [index, line] of raw.split('\n').entries()) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (hasForbiddenKey(value) || !value || Array.isArray(value) || typeof value !== 'object') {
        throw new Error('unsafe journal row');
      }
      if (value.event === 'placed') {
        const { event, ...candidate } = value;
        placed.push(parseProgress(`${JSON.stringify(candidate)}\n`, null)[0]);
        continue;
      }
      if (value.event === 'claim_intent' || value.event === 'claim_acquired') {
        if (Object.keys(value).sort().join(',') !== claimKeys.join(',')
            || typeof value.transcriptId !== 'string' || !value.transcriptId
            || typeof value.sourcePath !== 'string' || !isAbsolute(value.sourcePath)
            || /[\r\n\0]/.test(value.sourcePath)
            || !UUID_PATTERN.test(value.runId)
            || new Date(value.observedAt).toISOString() !== value.observedAt
            || !Number.isSafeInteger(value.ownerPid) || value.ownerPid <= 0) {
          throw new Error('invalid claim intent proof');
        }
        if (value.event === 'claim_intent') {
          claimIntents.push(value);
          precedingClaims.push(value);
        } else {
          const { event: _event, ...proof } = value;
          const predecessor = [...precedingClaims].reverse().find((candidate) => {
            const { event: _candidateEvent, ...candidateProof } = candidate;
            return isDeepStrictEqual(candidateProof, proof);
          });
          if (!predecessor) throw new Error('claim acquisition lacks an exact preceding intent');
          claimAcquired.push(value);
        }
        continue;
      }
      if (value.event !== 'intent' || Object.keys(value).sort().join(',') !== intentKeys.sort().join(',')) {
        throw new Error('invalid journal event');
      }
      const { event, desiredRecordPath, ...proof } = value;
      parseProgress(`${JSON.stringify({
        ...proof,
        status: 'mined',
        recordPath: desiredRecordPath,
      })}\n`, null);
      intents.push(value);
    } catch {
      issues.push({ kind: 'malformed_journal', line: index + 1 });
    }
  }
  return { placed, intents, claimIntents, claimAcquired, issues };
}

export function reconcileRunEvidence({ progressRaw, journalRaw = '', expected, supplementalRows = [] }) {
  const expectedById = new Map(expected.map((row) => [row.id, row.path]));
  const progress = parseEvidenceLines(progressRaw, 'progress');
  const journal = parsePlacementJournalEvidence(journalRaw);
  const issues = [...progress.issues, ...journal.issues];
  const accepted = new Map();
  const blocked = new Set();
  const block = (id, kind) => {
    accepted.delete(id);
    blocked.add(id);
    issues.push({ kind, transcriptId: id });
  };
  const accept = (row, conflictKind) => {
    const id = row.transcriptId;
    if (blocked.has(id)) return;
    const existing = accepted.get(id);
    if (existing && !isDeepStrictEqual(existing, row)) {
      block(id, conflictKind);
      return;
    }
    accepted.set(id, row);
  };

  for (const row of progress.rows) {
    if (expectedById.get(row.transcriptId) !== row.sourcePath) {
      issues.push({ kind: 'progress_source_mismatch', transcriptId: row.transcriptId });
      if (expectedById.has(row.transcriptId)) blocked.add(row.transcriptId);
      continue;
    }
    accept(row, 'conflicting_progress');
  }
  for (const row of supplementalRows) {
    parseProgress(`${JSON.stringify(row)}\n`, null);
    if (expectedById.get(row.transcriptId) !== row.sourcePath) {
      issues.push({ kind: 'supplemental_source_mismatch', transcriptId: row.transcriptId });
      if (expectedById.has(row.transcriptId)) blocked.add(row.transcriptId);
      continue;
    }
    const existing = accepted.get(row.transcriptId);
    const matchingAcquisition = journal.claimAcquired.some((claim) => (
      claim.transcriptId === row.transcriptId
      && claim.sourcePath === row.sourcePath
      && claim.runId === row.runId
      && claim.observedAt === row.observedAt
    ));
    const hasPlacementEvidence = journal.intents.some((intent) => intent.transcriptId === row.transcriptId)
      || journal.placed.some((placed) => placed.transcriptId === row.transcriptId);
    if (existing?.status === 'provider_failed'
        && row.status === 'claim_error'
        && row.detailCode === 'recovered-dead-owner-before-placement'
        && existing.transcriptId === row.transcriptId
        && existing.sourcePath === row.sourcePath
        && existing.runId === row.runId
        && existing.observedAt === row.observedAt
        && matchingAcquisition
        && !hasPlacementEvidence) {
      continue;
    }
    accept(row, 'supplemental_progress_conflict');
  }

  const journalById = new Map();
  for (const row of journal.placed) {
    if (expectedById.get(row.transcriptId) !== row.sourcePath) {
      issues.push({ kind: 'journal_source_mismatch', transcriptId: row.transcriptId });
      if (expectedById.has(row.transcriptId)) blocked.add(row.transcriptId);
      continue;
    }
    const existing = journalById.get(row.transcriptId);
    if (existing && !isDeepStrictEqual(existing, row)) {
      journalById.delete(row.transcriptId);
      block(row.transcriptId, 'conflicting_journal');
      continue;
    }
    if (!blocked.has(row.transcriptId)) journalById.set(row.transcriptId, row);
  }

  const intentById = new Map();
  for (const intent of journal.intents) {
    if (expectedById.get(intent.transcriptId) !== intent.sourcePath) {
      issues.push({ kind: 'journal_intent_source_mismatch', transcriptId: intent.transcriptId });
      if (expectedById.has(intent.transcriptId)) blocked.add(intent.transcriptId);
      continue;
    }
    const existing = intentById.get(intent.transcriptId);
    if (existing && !isDeepStrictEqual(existing, intent)) {
      intentById.delete(intent.transcriptId);
      block(intent.transcriptId, 'conflicting_journal_intent');
      continue;
    }
    if (!blocked.has(intent.transcriptId)) intentById.set(intent.transcriptId, intent);
  }

  for (const [id, row] of journalById) {
    if (blocked.has(id)) continue;
    const prior = accepted.get(id);
    if (prior && !isDeepStrictEqual(prior, row)) {
      block(id, 'journal_progress_conflict');
      continue;
    }
    const intent = intentById.get(id);
    if (intent) {
      const { event: _event, desiredRecordPath: recordPath, ...proof } = intent;
      const intended = { ...proof, status: 'mined', recordPath };
      if (!isDeepStrictEqual(intended, row)) {
        block(id, 'journal_intent_placement_conflict');
        continue;
      }
      intentById.delete(id);
    }
    accepted.set(id, row);
  }

  for (const [id, intent] of intentById) {
    if (blocked.has(id)) continue;
    const prior = accepted.get(id);
    if (prior) {
      const { event: _event, desiredRecordPath: recordPath, ...proof } = intent;
      const intended = { ...proof, status: 'mined', recordPath };
      if (!isDeepStrictEqual(intended, prior)) block(id, 'journal_intent_progress_conflict');
    }
  }
  const rows = [];
  const missing = [];
  const claimById = new Map();
  for (const intent of journal.claimIntents) {
    if (expectedById.get(intent.transcriptId) !== intent.sourcePath) {
      issues.push({ kind: 'claim_intent_source_mismatch', transcriptId: intent.transcriptId });
      if (expectedById.has(intent.transcriptId)) blocked.add(intent.transcriptId);
      continue;
    }
    const existing = claimById.get(intent.transcriptId);
    if (existing && !isDeepStrictEqual(existing, intent)) {
      claimById.delete(intent.transcriptId);
      block(intent.transcriptId, 'conflicting_claim_intent');
      continue;
    }
    if (!blocked.has(intent.transcriptId)) claimById.set(intent.transcriptId, intent);
  }
  const acquiredById = new Map();
  for (const acquired of journal.claimAcquired) {
    if (expectedById.get(acquired.transcriptId) !== acquired.sourcePath) {
      issues.push({ kind: 'claim_acquired_source_mismatch', transcriptId: acquired.transcriptId });
      if (expectedById.has(acquired.transcriptId)) blocked.add(acquired.transcriptId);
      continue;
    }
    const existing = acquiredById.get(acquired.transcriptId);
    if (existing && !isDeepStrictEqual(existing, acquired)) {
      acquiredById.delete(acquired.transcriptId);
      block(acquired.transcriptId, 'conflicting_claim_acquired');
      continue;
    }
    if (!blocked.has(acquired.transcriptId)) acquiredById.set(acquired.transcriptId, acquired);
  }
  for (const id of blocked) accepted.delete(id);
  for (const item of expected) {
    const row = accepted.get(item.id);
    if (row) rows.push(row);
    else missing.push({
      transcriptId: item.id,
      sourcePath: item.path,
      status: 'missing_progress',
      ...(blocked.has(item.id)
        ? { detailCode: 'evidence_conflict' }
        : intentById.has(item.id)
        ? { detailCode: 'placement_intent_unresolved' }
        : acquiredById.has(item.id)
          ? { detailCode: 'claim_acquired_unresolved' }
        : claimById.has(item.id)
          ? { detailCode: 'claim_intent_unproven' }
          : {}),
    });
  }
  return {
    rows,
    missing,
    issues,
    intents: [...intentById.entries()].filter(([id]) => !blocked.has(id)).map(([, intent]) => intent),
    claimIntents: journal.claimIntents,
    claimAcquired: journal.claimAcquired,
    blockedTranscriptIds: [...blocked].sort(),
  };
}

export function selectReleasedClaimRows(dispositions, claimIntents) {
  if (!claimIntents.length || !existsSync(dispositions)) return [];
  privateDirectory(dirname(dispositions), 'disposition parent');
  privateRegular(dispositions, 'disposition ledger');
  const identities = new Set(claimIntents.map((row) => `${row.runId}\0${row.transcriptId}\0${row.sourcePath}`));
  const selected = new Map();
  for (const line of readPrivate(dispositions, 'disposition ledger').split('\n')) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row?.status !== 'claim_error' || row.detailCode !== 'recovered-dead-owner-before-placement') continue;
    const identity = `${row.runId}\0${row.transcriptId}\0${row.sourcePath}`;
    if (!identities.has(identity)) continue;
    parseProgress(`${JSON.stringify(row)}\n`, null);
    const prior = selected.get(identity);
    if (prior && JSON.stringify(prior) !== JSON.stringify(row)) {
      throw new Error(`conflicting released-claim proof for ${row.transcriptId}`);
    }
    selected.set(identity, row);
  }
  return [...selected.values()];
}

function run(command, args, { cwd, timeoutMs, env } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: env ?? process.env,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const failureReason = result.error?.code === 'ETIMEDOUT'
    ? 'timeout'
    : result.error?.code === 'ENOENT'
      ? 'unavailable'
      : result.status === null
        ? 'spawn_error'
        : null;
  return {
    code: result.status ?? 124,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    failureReason,
  };
}

const sha256Private = (path, label) => createHash('sha256').update(readPrivate(path, label, null)).digest('hex');

function sha256StableRegular(path, label, maxBytes = 16_000_000) {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes) {
    throw new Error(`${label} is not a bounded regular file`);
  }
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size
        || opened.mtimeMs !== before.mtimeMs) {
      throw new Error(`${label} changed during open`);
    }
    const body = readFileSync(fd);
    const after = fstatSync(fd);
    const finalPath = lstatSync(path);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
        || after.mtimeMs !== opened.mtimeMs || finalPath.isSymbolicLink() || !finalPath.isFile()
        || finalPath.dev !== after.dev || finalPath.ino !== after.ino || finalPath.size !== after.size
        || finalPath.mtimeMs !== after.mtimeMs) {
      throw new Error(`${label} changed while it was read`);
    }
    return createHash('sha256').update(body).digest('hex');
  } finally { closeSync(fd); }
}

export function scanExactRecords({ scanner, paths, execute = run }) {
  if (!existsSync(scanner) || !lstatSync(scanner).isFile()) {
    throw new Error(`credential scanner unavailable at ${scanner}`);
  }
  for (const path of paths) {
    const result = execute(process.execPath, [scanner, path], { timeoutMs: 120_000 });
    if (result.code !== 0) {
      throw new Error(`credential scan failed for ${path}: exit_${result.code}`);
    }
  }
}

export function finalizeCaptured({
  drainer,
  progress,
  dispositions,
  commit,
  expected,
  timeoutMs,
  execute = run,
}) {
  const result = execute(process.execPath, [
    drainer,
    '--finalize-progress', progress,
    '--commit', commit,
    '--dispositions', dispositions,
  ], { timeoutMs });
  if (result.code !== 0) {
    throw new Error(`captured disposition finalization failed: ${result.failureReason ?? `exit_${result.code}`}`);
  }
  let receipt;
  try { receipt = JSON.parse(result.stdout.trim()); }
  catch { throw new Error('captured disposition finalization returned malformed metadata'); }
  if (!receipt || Object.keys(receipt).sort().join(',') !== 'finalized,status'
      || receipt.status !== 'captured' || receipt.finalized !== expected) {
    throw new Error('captured disposition finalization count mismatch');
  }
}

export function verifyCapturedDispositions(dispositions, minedRows, commit) {
  privateDirectory(dirname(dispositions), 'disposition parent');
  const rows = readPrivate(dispositions, 'disposition ledger').split('\n').filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); }
    catch { throw new Error(`malformed disposition row ${index + 1}`); }
  });
  for (const mined of minedRows) {
    const matches = rows.filter((row) => row.status === 'captured'
      && row.transcriptId === mined.transcriptId
      && row.sourcePath === mined.sourcePath
      && row.sourceSha256 === mined.sourceSha256
      && row.recordPath === mined.recordPath
      && row.recordSha256 === mined.recordSha256
      && row.commit === commit);
    if (matches.length !== 1) {
      throw new Error(`captured disposition proof mismatch for ${mined.transcriptId}`);
    }
    const [captured] = matches;
    if (typeof captured.reachability !== 'string' || !captured.reachability
        || hasForbiddenKey(captured)) {
      throw new Error(`captured disposition metadata invalid for ${mined.transcriptId}`);
    }
  }
}

function privateRegular(path, label) {
  const { fd, stat } = openPrivateRegular(path, label);
  closeSync(fd);
  return stat;
}

function writePrivateAtomicIfAbsent(path, body, label) {
  if (existsSync(path)) {
    if (readPrivate(path, label) !== body) throw new Error(`${label} conflicts with durable state`);
    return path;
  }
  const parent = dirname(path);
  privateDirectory(parent, `${label} parent`);
  const temporary = join(dirname(path), `.${basename(path)}.tmp-${randomUUID()}`);
  const fd = withPrivateUmask(() => openSync(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    PRIVATE_FILE_MODE,
  ));
  try {
    fchmodSync(fd, PRIVATE_FILE_MODE);
    writeAll(fd, body);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  privateRegular(temporary, `${label} temporary file`);
  try {
    linkSync(temporary, path);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    if (readPrivate(path, label) !== body) throw new Error(`${label} conflicts with durable state`);
  } finally {
    try { unlinkSync(temporary); } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  fsyncDirectory(parent);
  privateRegular(path, label);
  return path;
}

export function writePrivateReceipt(path, body, label = 'private receipt') {
  if (typeof path !== 'string' || !isAbsolute(path) || /[\r\n\0]/.test(path)
      || typeof body !== 'string' || body.length > 1_048_576
      || typeof label !== 'string' || !label) {
    throw new Error('invalid private receipt request');
  }
  return writePrivateAtomicIfAbsent(path, body, label);
}

function verifyCommittedTransaction(vault, minedRows, commit, execute = run) {
  if (!/^[a-f0-9]{40,64}$/i.test(commit)) throw new Error('pending transaction has an invalid commit object id');
  const reachable = execute('git', ['merge-base', '--is-ancestor', commit, 'HEAD'], { cwd: vault });
  if (reachable.code !== 0) throw new Error('pending transaction commit is not reachable from vault HEAD');
  const expectedPaths = [];
  for (const row of minedRows) {
    const requested = resolve(row.recordPath);
    if (!contained(requested, resolve(vault))) throw new Error(`pending record escaped vault for ${row.transcriptId}`);
    const recordRelative = relative(resolve(vault), requested);
    if (!/^project-memory\/[^/]+\/sessions\/[^/]+\.md$/.test(recordRelative)) {
      throw new Error(`pending record path is invalid for ${row.transcriptId}`);
    }
    const object = execute('git', ['cat-file', 'blob', `${commit}:${recordRelative}`], { cwd: vault });
    if (object.code !== 0 || createHash('sha256').update(object.stdout).digest('hex') !== row.recordSha256) {
      throw new Error(`pending commit record proof mismatch for ${row.transcriptId}`);
    }
    expectedPaths.push(recordRelative);
  }
  const actualPaths = execute('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', commit], { cwd: vault });
  if (actualPaths.code !== 0) throw new Error('pending transaction commit path query failed');
  assertSamePaths(actualPaths.stdout.split('\n').filter(Boolean).sort(), expectedPaths.sort());
}

function derivePendingCommit(vault, beforeHead, minedRows, execute = run) {
  if (!/^[a-f0-9]{40,64}$/i.test(beforeHead)) throw new Error('pending transaction has an invalid before object id');
  const ancestor = execute('git', ['merge-base', '--is-ancestor', beforeHead, 'HEAD'], { cwd: vault });
  if (ancestor.code !== 0) throw new Error('pending transaction base is not reachable from vault HEAD');
  const range = execute('git', ['rev-list', '--reverse', `${beforeHead}..HEAD`], { cwd: vault });
  if (range.code !== 0) throw new Error('pending transaction history query failed');
  const matches = [];
  for (const commit of range.stdout.split('\n').filter(Boolean)) {
    try {
      verifyCommittedTransaction(vault, minedRows, commit, execute);
      matches.push(commit);
    } catch {
      // Non-matching intervening commits are expected; uniqueness is enforced below.
    }
  }
  if (matches.length !== 1) {
    throw new Error(`pending transaction commit derivation expected 1 match, received ${matches.length}`);
  }
  return matches[0];
}

function verifyRolledBackTransaction(specPath, recoveryManifest, dispositions, ledgerPath, minedRows) {
  privateRegular(specPath, 'rolled-back transaction specification');
  privateRegular(recoveryManifest, 'rolled-back recovery manifest');
  privateDirectory(dirname(dispositions), 'disposition parent');
  privateRegular(dispositions, 'disposition ledger');
  const manifestBody = readPrivate(recoveryManifest, 'rolled-back recovery manifest');
  const manifestSha256 = createHash('sha256').update(manifestBody).digest('hex');
  const mappings = manifestBody.split('\n').filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); }
    catch { throw new Error(`malformed recovery manifest row ${index + 1}`); }
  });
  if (mappings.length !== minedRows.length) throw new Error('rolled-back recovery manifest is incomplete');
  const dispositionRows = readPrivate(dispositions, 'disposition ledger').split('\n').filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); }
    catch { throw new Error(`malformed disposition row ${index + 1}`); }
  });
  const claimed = readLedgerStrict(ledgerPath);
  for (const row of minedRows) {
    if (claimed.has(row.transcriptId)) throw new Error(`rolled-back claim remains for ${row.transcriptId}`);
    const matches = mappings.filter((mapping) => mapping
      && Object.keys(mapping).sort().join(',') === 'recordPath,recordSha256,recoveredPath,transcriptId'
      && mapping.transcriptId === row.transcriptId
      && mapping.recordPath === row.recordPath
      && mapping.recordSha256 === row.recordSha256);
    if (matches.length !== 1) throw new Error(`rolled-back recovery proof mismatch for ${row.transcriptId}`);
    const [mapping] = matches;
    if (existsSync(mapping.recordPath)) throw new Error(`rolled-back record remains at its original path for ${row.transcriptId}`);
    privateRegular(mapping.recoveredPath, 'rolled-back recovered record');
    if (sha256Private(mapping.recoveredPath, 'rolled-back recovered record') !== row.recordSha256) {
      throw new Error(`rolled-back recovery hash mismatch for ${row.transcriptId}`);
    }
    const terminal = dispositionRows.filter((candidate) => candidate.status === 'claim_error'
      && candidate.transcriptId === row.transcriptId
      && candidate.recordPath === row.recordPath
      && candidate.recordSha256 === row.recordSha256
      && candidate.detailCode === 'rolled-back-to-recovery'
      && candidate.recoveryManifest === recoveryManifest
      && candidate.recoveryManifestSha256 === manifestSha256);
    if (terminal.length !== 1) throw new Error(`rolled-back disposition proof mismatch for ${row.transcriptId}`);
  }
}

function finalizeUnderVaultLock({ vault, lib, drainer, progress, dispositions, commit, expected, timeoutMs }) {
  const script = [
    'set -u',
    'source "$1"',
    'vault="$2"',
    'drainer="$3"',
    'progress="$4"',
    'dispositions="$5"',
    'commit="$6"',
    'lk="$(wrap_lock "vault-$vault" 60)" || exit 70',
    'trap \'wrap_unlock "$lk" >/dev/null 2>&1 || true\' EXIT HUP INT TERM',
    'node "$drainer" --finalize-progress "$progress" --commit "$commit" --dispositions "$dispositions"',
  ].join('\n');
  const result = run('/bin/bash', [
    '-c', script, '_', lib, vault, drainer, progress, dispositions, commit,
  ], { timeoutMs });
  if (result.code !== 0) {
    throw new Error(`pending captured disposition finalization failed: ${result.failureReason ?? `exit_${result.code}`}`);
  }
  const lines = result.stdout.split('\n').filter(Boolean);
  let receipt;
  try { receipt = JSON.parse(lines.at(-1)); }
  catch { throw new Error('pending captured disposition finalization returned malformed metadata'); }
  if (!receipt || Object.keys(receipt).sort().join(',') !== 'finalized,status'
      || receipt.status !== 'captured' || receipt.finalized !== expected) {
    throw new Error('pending captured disposition finalization count mismatch');
  }
}

function rollbackUnderVaultLock({
  vault, lib, wrapper, rollbackSpec, drainer, progress, recoveryManifest,
  dispositions, expected, timeoutMs,
}) {
  const script = [
    'set -u',
    'source "$1"',
    'vault="$2"',
    'wrapper="$3"',
    'spec="$4"',
    'drainer="$5"',
    'progress="$6"',
    'recovery="$7"',
    'dispositions="$8"',
    'lk="$(wrap_lock "vault-$vault" 60)" || exit 70',
    'trap \'wrap_unlock "$lk" >/dev/null 2>&1 || true\' EXIT HUP INT TERM',
    'node --input-type=module -e \'const m=await import(process.argv[2]); await m.rollbackPlacedRecords(process.argv[3], process.argv[4], process.argv[5]);\' stack-stray-library "$wrapper" "$spec" "$recovery" "$vault"',
    'node "$drainer" --rollback-progress "$progress" --recovery-manifest "$recovery" --dispositions "$dispositions"',
  ].join('\n');
  const result = run('/bin/bash', [
    '-c', script, '_', lib, vault, wrapper, rollbackSpec,
    drainer, progress, recoveryManifest, dispositions,
  ], { timeoutMs });
  if (result.code !== 0) {
    throw new Error(`pending rollback finalization failed: ${result.failureReason ?? `exit_${result.code}`}`);
  }
  const lines = result.stdout.split('\n').filter(Boolean);
  let receipt;
  try { receipt = JSON.parse(lines.at(-1)); }
  catch { throw new Error('pending rollback finalization returned malformed metadata'); }
  if (!receipt || Object.keys(receipt).sort().join(',') !== 'rolledBack,status'
      || receipt.status !== 'claim_error' || receipt.rolledBack !== expected) {
    throw new Error('pending rollback finalization count mismatch');
  }
}

function recoverPlacementJournalUnderVaultLock({ vault, lib, drainer, placementJournal, dispositions, timeoutMs }) {
  const script = [
    'set -u',
    'source "$1"',
    'vault="$2"',
    'drainer="$3"',
    'journal="$4"',
    'dispositions="$5"',
    'lk="$(wrap_lock "vault-$vault" 60)" || exit 70',
    'trap \'wrap_unlock "$lk" >/dev/null 2>&1 || true\' EXIT HUP INT TERM',
    'node "$drainer" --recover-placement-journal "$journal" --dispositions "$dispositions"',
  ].join('\n');
  const result = run('/bin/bash', [
    '-c', script, '_', lib, vault, drainer, placementJournal, dispositions,
  ], { timeoutMs });
  if (result.code !== 0) {
    throw new Error(`placement journal recovery failed: ${result.failureReason ?? `exit_${result.code}`}`);
  }
  const lines = result.stdout.split('\n').filter(Boolean);
  let receipt;
  try { receipt = JSON.parse(lines.at(-1)); }
  catch { throw new Error('placement journal recovery returned malformed metadata'); }
  if (!receipt || Object.keys(receipt).sort().join(',') !== 'active,missing,recovered,released,status,unproven'
      || receipt.status !== 'reconciled'
      || ['active', 'missing', 'recovered', 'released', 'unproven'].some((key) => (
        !Number.isSafeInteger(receipt[key]) || receipt[key] < 0
      ))) {
    throw new Error('placement journal recovery returned invalid metadata');
  }
  return receipt;
}

function writeTransactionResolution(runDirectory, { status, commit = null, records }) {
  const validResolution = (candidateStatus, candidateCommit, candidateRecords) => (
    (candidateStatus === 'captured' && /^[a-f0-9]{40,64}$/i.test(candidateCommit ?? '') && candidateRecords > 0)
    || (candidateStatus === 'rolled_back' && candidateCommit === null && candidateRecords > 0)
    || (candidateStatus === 'no_placements' && candidateCommit === null && candidateRecords === 0)
  );
  if (!Number.isSafeInteger(records) || !validResolution(status, commit, records)) {
    throw new Error('transaction resolution state is invalid');
  }
  const path = join(runDirectory, 'transaction-resolution.json');
  const value = { schemaVersion: 1, status, commit, records };
  if (existsSync(path)) {
    privateRegular(path, 'transaction resolution');
    let prior;
    try { prior = JSON.parse(readPrivate(path, 'transaction resolution')); }
    catch { throw new Error('transaction resolution is malformed'); }
    const keys = ['commit', 'records', 'resolvedAt', 'schemaVersion', 'status'];
    if (!prior || Array.isArray(prior) || typeof prior !== 'object'
        || Object.keys(prior).sort().join(',') !== keys.join(',')
        || !Number.isSafeInteger(prior.records)
        || !validResolution(prior.status, prior.commit, prior.records)
        || typeof prior.resolvedAt !== 'string'
        || new Date(prior.resolvedAt).toISOString() !== prior.resolvedAt) {
      throw new Error('transaction resolution is invalid');
    }
    if (prior.schemaVersion !== value.schemaVersion || prior.status !== value.status
        || prior.commit !== value.commit || prior.records !== value.records) {
      throw new Error('transaction resolution conflicts with verified state');
    }
    return path;
  }
  return writePrivateAtomicIfAbsent(
    path,
    `${JSON.stringify({ ...value, resolvedAt: new Date().toISOString() })}\n`,
    'transaction resolution',
  );
}

function validateIncompleteRetirement(runDirectory) {
  const retirement = join(runDirectory, 'incomplete-progress-retirement.json');
  const incomplete = join(runDirectory, 'incomplete-progress.json');
  const resolution = join(runDirectory, 'transaction-resolution.json');
  if (!existsSync(retirement)) return false;
  privateRegular(retirement, 'incomplete progress retirement');
  privateRegular(incomplete, 'incomplete progress receipt');
  privateRegular(resolution, 'transaction resolution');
  let row;
  try { row = JSON.parse(readPrivate(retirement, 'incomplete progress retirement')); }
  catch { throw new Error('incomplete progress retirement is malformed'); }
  const keys = [
    'incompleteReceiptSha256', 'issueCount', 'missingCount', 'retiredAt',
    'schemaVersion', 'status', 'transactionResolutionSha256',
  ];
  if (!row || Array.isArray(row) || typeof row !== 'object'
      || Object.keys(row).sort().join(',') !== keys.join(',')
      || row.schemaVersion !== 1 || row.status !== 'transaction_retired'
      || !Number.isSafeInteger(row.missingCount) || row.missingCount < 0
      || !Number.isSafeInteger(row.issueCount) || row.issueCount < 0
      || !/^[a-f0-9]{64}$/.test(row.incompleteReceiptSha256)
      || !/^[a-f0-9]{64}$/.test(row.transactionResolutionSha256)
      || typeof row.retiredAt !== 'string'
      || new Date(row.retiredAt).toISOString() !== row.retiredAt
      || sha256Private(incomplete, 'incomplete progress receipt') !== row.incompleteReceiptSha256
      || sha256Private(resolution, 'transaction resolution') !== row.transactionResolutionSha256) {
    throw new Error('incomplete progress retirement is invalid');
  }
  return true;
}

function retireIncompleteReceipt(runDirectory) {
  const incomplete = join(runDirectory, 'incomplete-progress.json');
  if (!existsSync(incomplete)) return null;
  const retirement = join(runDirectory, 'incomplete-progress-retirement.json');
  if (existsSync(retirement)) {
    validateIncompleteRetirement(runDirectory);
    return retirement;
  }
  privateRegular(incomplete, 'incomplete progress receipt');
  const resolution = join(runDirectory, 'transaction-resolution.json');
  privateRegular(resolution, 'transaction resolution');
  let prior;
  try { prior = JSON.parse(readPrivate(incomplete, 'incomplete progress receipt')); }
  catch { throw new Error('incomplete progress receipt is malformed'); }
  if (!prior || !Array.isArray(prior.missing) || !Array.isArray(prior.issues)) {
    throw new Error('incomplete progress receipt is invalid');
  }
  return writePrivateAtomicIfAbsent(
    retirement,
    `${JSON.stringify({
      schemaVersion: 1,
      status: 'transaction_retired',
      retiredAt: new Date().toISOString(),
      incompleteReceiptSha256: sha256Private(incomplete, 'incomplete progress receipt'),
      transactionResolutionSha256: sha256Private(resolution, 'transaction resolution'),
      missingCount: prior.missing.length,
      issueCount: prior.issues.length,
    })}\n`,
    'incomplete progress retirement',
  );
}

function evidenceCanRetireTransaction(evidence, recovery) {
  if (recovery.active || recovery.missing || recovery.unproven) return false;
  if (evidence.blockedTranscriptIds.length || evidence.intents.length) return false;
  if (evidence.missing.some((row) => row.detailCode)) return false;
  return evidence.issues.every((issue) => issue.kind === 'malformed_progress');
}

function readExpectedSources(listFile) {
  return readPrivate(listFile, 'transaction source list').split('\n').filter(Boolean).map((path) => {
    if (!isAbsolute(path) || /[\r\n\0]/.test(path)) throw new Error('transaction source list contains an unsafe path');
    const id = basename(path, '.jsonl');
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(id)) throw new Error('transaction source list contains an unsafe identifier');
    return { id, path };
  });
}

function readTransactionBase(runDirectory) {
  const ownerPath = join(runDirectory, 'transaction-owner.json');
  const owner = JSON.parse(readPrivate(ownerPath, 'transaction ownership receipt'));
  if (!owner || owner.schemaVersion !== 1 || !/^[a-f0-9]{40,64}$/i.test(owner.vaultHead)) {
    throw new Error('transaction ownership receipt lacks a valid vault head');
  }
  return owner.vaultHead;
}

function rollbackRecoveryHasStarted(specPath) {
  privateRegular(specPath, 'transaction rollback specification');
  let spec;
  try { spec = JSON.parse(readPrivate(specPath, 'transaction rollback specification')); }
  catch { throw new Error('transaction rollback specification is malformed'); }
  if (!spec || Array.isArray(spec) || typeof spec !== 'object'
      || typeof spec.quarantineRoot !== 'string' || !isAbsolute(spec.quarantineRoot)
      || !Array.isArray(spec.rows) || !spec.rows.length) {
    throw new Error('transaction rollback specification is invalid');
  }
  let started = false;
  for (const row of spec.rows) {
    if (!row || typeof row.recordPath !== 'string' || !isAbsolute(row.recordPath)
        || typeof row.recordRelative !== 'string'
        || !/^project-memory\/[^/]+\/sessions\/[^/]+\.md$/.test(row.recordRelative)) {
      throw new Error('transaction rollback specification contains an invalid record');
    }
    const destination = join(spec.quarantineRoot, row.recordRelative);
    if (!contained(resolve(destination), resolve(spec.quarantineRoot))) {
      throw new Error('transaction rollback recovery path escaped quarantine');
    }
    const sourceExists = existsSync(row.recordPath);
    const destinationExists = existsSync(destination);
    if (sourceExists && destinationExists) {
      throw new Error(`rollback found both source and recovery copies for ${row.transcriptId}`);
    }
    if (destinationExists || !sourceExists) started = true;
  }
  return started;
}

function transactionOwnerIsActive(runDirectory) {
  const ownerPath = join(runDirectory, 'transaction-owner.json');
  if (!existsSync(ownerPath)) return false;
  let owner;
  try { owner = JSON.parse(readPrivate(ownerPath, 'transaction ownership receipt')); }
  catch { throw new Error('transaction ownership receipt is malformed'); }
  const keys = ['createdAt', 'ownerPid', 'schemaVersion', 'sources', 'vaultHead'];
  if (!owner || Array.isArray(owner) || typeof owner !== 'object'
      || Object.keys(owner).sort().join(',') !== keys.join(',')
      || owner.schemaVersion !== 1
      || typeof owner.createdAt !== 'string'
      || new Date(owner.createdAt).toISOString() !== owner.createdAt
      || !Number.isSafeInteger(owner.ownerPid) || owner.ownerPid <= 0
      || !Array.isArray(owner.sources)
      || !owner.sources.every((row) => row && !Array.isArray(row) && typeof row === 'object'
        && Object.keys(row).sort().join(',') === 'sourcePath,transcriptId'
        && typeof row.transcriptId === 'string' && row.transcriptId
        && typeof row.sourcePath === 'string' && isAbsolute(row.sourcePath)
        && !/[\r\n\0]/.test(row.sourcePath))
      || (owner.vaultHead !== null && !/^[a-f0-9]{40,64}$/i.test(owner.vaultHead))) {
    throw new Error('transaction ownership receipt is invalid');
  }
  try {
    process.kill(owner.ownerPid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    return true;
  }
}

export function resumePendingFinalizations({
  logDir,
  vault,
  lib,
  drainer,
  dispositions,
  ledgerPath,
  timeoutMs,
  wrapper = fileURLToPath(import.meta.url),
  scanner,
  quiescenceMinutes,
}) {
  if (!existsSync(logDir)) return [];
  privateDirectory(logDir, 'log directory');
  privateDirectory(dirname(dispositions), 'disposition parent');
  privateDirectory(dirname(ledgerPath), 'ledger parent');
  if (existsSync(dispositions)) privateRegular(dispositions, 'disposition ledger');
  if (existsSync(ledgerPath)) privateRegular(ledgerPath, 'ledger');
  const resumed = [];
  for (const entry of readdirSync(logDir, { withFileTypes: true })) {
    if (!entry.name.startsWith('run-')) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error(`unsafe resumed run state: ${entry.name} is not a private run directory`);
    }
    const runDirectory = join(logDir, entry.name);
    privateDirectory(runDirectory, 'run directory');
    const resolution = join(runDirectory, 'transaction-resolution.json');
    const incomplete = join(runDirectory, 'incomplete-progress.json');
    if (existsSync(resolution)
        && (!existsSync(incomplete) || validateIncompleteRetirement(runDirectory))) {
      let prior;
      try { prior = JSON.parse(readPrivate(resolution, 'transaction resolution')); }
      catch { throw new Error('transaction resolution is malformed'); }
      writeTransactionResolution(runDirectory, {
        status: prior.status,
        commit: prior.commit,
        records: prior.records,
      });
      continue;
    }
    if (transactionOwnerIsActive(runDirectory)) {
      resumed.push({ runDirectory, commit: null, status: 'owner_active', finalized: 0 });
      continue;
    }
    const transactionProgressPath = join(runDirectory, 'transaction-progress.jsonl');
    let progress = existsSync(transactionProgressPath)
      ? transactionProgressPath
      : join(runDirectory, 'progress.jsonl');
    const commitOid = join(runDirectory, 'commit-oid.txt');
    const rollbackSpec = join(runDirectory, 'rollback-spec.json');
    const placementJournal = join(runDirectory, 'placement-journal.jsonl');
    const recoveryManifest = join(runDirectory, 'rollback', 'recovery-manifest.jsonl');
    const rollbackStarted = existsSync(rollbackSpec)
      && (existsSync(recoveryManifest) || rollbackRecoveryHasStarted(rollbackSpec));
    if (!existsSync(commitOid) && rollbackStarted) {
      const rows = parseProgress(readPrivate(progress, 'pending progress ledger'), null);
      privateRegular(dispositions, 'disposition ledger');
      const mined = rows.filter((row) => row.status === 'mined');
      if (!mined.length) throw new Error(`pending transaction ${entry.name} has no mined rows`);
      rollbackUnderVaultLock({
        vault, lib, wrapper, rollbackSpec, drainer, progress, recoveryManifest,
        dispositions, expected: mined.length, timeoutMs,
      });
      verifyRolledBackTransaction(rollbackSpec, recoveryManifest, dispositions, ledgerPath, mined);
      writeTransactionResolution(runDirectory, { status: 'rolled_back', records: mined.length });
      retireIncompleteReceipt(runDirectory);
      resumed.push({ runDirectory, commit: null, status: 'rolled_back', finalized: 0 });
      continue;
    }
    let reconciliationSafe = false;
    if (existsSync(placementJournal)) {
      privateRegular(placementJournal, 'placement journal');
      let recovery = {
        recovered: 0, released: 0, active: 0, missing: 0, unproven: 0, status: 'reconciled',
      };
      if (privateRegular(placementJournal, 'placement journal').size > 0) {
        recovery = recoverPlacementJournalUnderVaultLock({
          vault,
          lib,
          drainer,
          placementJournal,
          dispositions,
          timeoutMs,
        });
      }
      if (existsSync(dispositions)) privateRegular(dispositions, 'disposition ledger');
      else if (recovery.recovered || recovery.released) {
        throw new Error('placement journal recovery reported a durable disposition without a ledger');
      }
      const originalProgress = join(runDirectory, 'progress.jsonl');
      privateRegular(originalProgress, 'pending progress ledger');
      const expected = readExpectedSources(join(runDirectory, 'sources.txt'));
      const journalRaw = readPrivate(placementJournal, 'placement journal');
      const journalPreview = parsePlacementJournalEvidence(journalRaw);
      const supplementalRows = selectReleasedClaimRows(dispositions, journalPreview.claimIntents);
      const evidence = reconcileRunEvidence({
        progressRaw: readPrivate(originalProgress, 'pending progress ledger'),
        journalRaw,
        expected,
        supplementalRows,
      });
      reconciliationSafe = evidenceCanRetireTransaction(evidence, recovery);
      if ((evidence.missing.length || evidence.issues.length) && !existsSync(incomplete)) {
        writePrivateAtomicIfAbsent(incomplete, `${JSON.stringify({
          schemaVersion: 1,
          observedAt: new Date().toISOString(),
          childFailure: 'startup-recovery',
          missing: evidence.missing,
          issues: evidence.issues,
          journalActive: recovery.active,
          journalMissing: recovery.missing,
          journalUnproven: recovery.unproven,
        })}\n`, 'incomplete progress receipt');
      }
      const minedEvidence = evidence.rows.filter((row) => row.status === 'mined');
      if (minedEvidence.length && !existsSync(rollbackSpec)) {
        materializeTransaction({
          runDirectory,
          vault,
          mined: minedEvidence,
          beforeHead: readTransactionBase(runDirectory),
        });
      }
      if (!minedEvidence.length && !existsSync(commitOid) && !existsSync(rollbackSpec)) {
        if (!reconciliationSafe) {
          resumed.push({ runDirectory, commit: null, status: 'evidence_unresolved', finalized: 0 });
          continue;
        }
        writeTransactionResolution(runDirectory, { status: 'no_placements', records: 0 });
        retireIncompleteReceipt(runDirectory);
        continue;
      }
      progress = existsSync(transactionProgressPath) ? transactionProgressPath : progress;
    }
    if (!existsSync(commitOid) && !existsSync(rollbackSpec)) continue;
    const rows = parseProgress(readPrivate(progress, 'pending progress ledger'), null);
    privateRegular(dispositions, 'disposition ledger');
    const mined = rows.filter((row) => row.status === 'mined');
    if (!mined.length) throw new Error(`pending transaction ${entry.name} has no mined rows`);
    let commit;
    if (existsSync(commitOid)) {
      commit = readPrivate(commitOid, 'pending commit receipt').trim();
    } else {
      const transaction = JSON.parse(readPrivate(rollbackSpec, 'pending transaction specification'));
      if (!transaction || transaction.schemaVersion !== 1 || typeof transaction.beforeHead !== 'string'
          || !Array.isArray(transaction.rows) || transaction.rows.length !== mined.length) {
        throw new Error(`pending transaction ${entry.name} has an invalid recovery specification`);
      }
      const head = run('git', ['rev-parse', 'HEAD'], { cwd: vault }).stdout.trim();
      if (head === transaction.beforeHead) {
        if (!scanner || !quiescenceMinutes) {
          throw new Error(`pending transaction ${entry.name} requires pre-commit recovery inputs`);
        }
        const messageFile = join(runDirectory, 'commit-message.txt');
        privateRegular(messageFile, 'pending commit message');
        const paths = transaction.rows.map((row) => row.recordRelative);
        const committed = commitExact({
          vault, lib, paths, messageFile, timeoutMs, wrapper, rollbackSpec,
          recoveryManifest, drainer, progress, dispositions, commitOid,
          scanner, quiescenceMinutes,
        });
        if (committed.code !== 0) {
          throw new Error(`pending exact-path vault commit failed: ${committed.failureReason ?? `exit_${committed.code}`}`);
        }
        commit = readPrivate(commitOid, 'pending commit receipt').trim();
      } else {
        commit = derivePendingCommit(vault, transaction.beforeHead, mined);
        writePrivateAtomicIfAbsent(commitOid, `${commit}\n`, 'pending commit receipt');
      }
    }
    verifyCommittedTransaction(vault, mined, commit);

    finalizeUnderVaultLock({
      vault, lib, drainer, progress, dispositions, commit,
      expected: mined.length,
      timeoutMs,
    });
    verifyCapturedDispositions(dispositions, mined, commit);
    writeTransactionResolution(runDirectory, { status: 'captured', commit, records: mined.length });
    if (reconciliationSafe) retireIncompleteReceipt(runDirectory);
    resumed.push({ runDirectory, commit, status: 'captured', finalized: mined.length });
  }
  return resumed;
}

export function validateMinedRows(rows, vault, execute = run) {
  const inputRoot = resolve(vault);
  const root = realpathSync(vault);
  const mined = rows.filter((row) => row.status === 'mined');
  const paths = [];
  const absolutePaths = [];
  for (const row of mined) {
    if (typeof row.recordPath !== 'string' || !isAbsolute(row.recordPath)) {
      throw new Error(`invalid record path for ${row.transcriptId}`);
    }
    const requestedPath = resolve(row.recordPath);
    if (!contained(requestedPath, inputRoot)) throw new Error(`record escaped vault for ${row.transcriptId}`);
    const recordRelative = relative(inputRoot, requestedPath);
    if (!/^project-memory\/[^/]+\/sessions\/[^/]+\.md$/.test(recordRelative)) {
      throw new Error(`invalid record path for ${row.transcriptId}`);
    }
    const path = realpathSync(requestedPath);
    if (relative(root, path) !== recordRelative) {
      throw new Error(`record path contains a symlink for ${row.transcriptId}`);
    }
    if (sha256Private(path, `record for ${row.transcriptId}`) !== row.recordSha256) {
      throw new Error(`record hash mismatch for ${row.transcriptId}`);
    }
    const tracked = execute('git', ['cat-file', '-e', `HEAD:${recordRelative}`], { cwd: root });
    if (tracked.code === 0) throw new Error(`record path already exists in HEAD for ${row.transcriptId}`);
    if (![1, 128].includes(tracked.code)) throw new Error(`record history check failed for ${row.transcriptId}`);
    const untracked = execute('git', ['ls-files', '--others', '--exclude-standard', '--', recordRelative], { cwd: root });
    if (untracked.code !== 0 || untracked.stdout.trim() !== recordRelative) {
      throw new Error(`record is not an exact untracked path for ${row.transcriptId}`);
    }
    paths.push(recordRelative);
    absolutePaths.push(path);
  }
  if (new Set(paths).size !== paths.length) throw new Error('duplicate record path in progress');
  return { mined, paths, absolutePaths };
}

function materializeTransaction({ runDirectory, vault, mined, beforeHead }) {
  if (!/^[a-f0-9]{40,64}$/i.test(beforeHead)) throw new Error('transaction base is not a full object id');
  const { paths, absolutePaths } = validateMinedRows(mined, vault);
  if (!paths.length) throw new Error('cannot materialize a transaction without mined records');
  const rollbackDirectory = join(runDirectory, 'rollback');
  privateDirectory(runDirectory, 'run directory');
  ensurePrivateDirectory(rollbackDirectory, 'rollback directory');
  const transactionProgress = join(runDirectory, 'transaction-progress.jsonl');
  const messageFile = join(runDirectory, 'commit-message.txt');
  const rollbackSpec = join(runDirectory, 'rollback-spec.json');
  const recoveryManifest = join(rollbackDirectory, 'recovery-manifest.jsonl');
  const commitOid = join(runDirectory, 'commit-oid.txt');
  writePrivateAtomicIfAbsent(
    transactionProgress,
    `${mined.map((row) => JSON.stringify(row)).join('\n')}\n`,
    'transaction progress ledger',
  );
  writePrivateAtomicIfAbsent(
    messageFile,
    `vault: drain ${paths.length} abandoned transcript(s)\n\n`
      + `Scheduled bounded drain ${basename(runDirectory)}. Records are append only. Raw transcripts were retained.\n`,
    'transaction commit message',
  );
  writePrivateAtomicIfAbsent(
    rollbackSpec,
    `${JSON.stringify({
      schemaVersion: 1,
      beforeHead,
      quarantineRoot: join(rollbackDirectory, 'records'),
      rows: mined.map((row, index) => ({
        transcriptId: row.transcriptId,
        sourcePath: row.sourcePath,
        sourceSha256: row.sourceSha256,
        recordPath: row.recordPath,
        recordRelative: paths[index],
        recordSha256: row.recordSha256,
      })),
    })}\n`,
    'transaction rollback specification',
  );
  return {
    mined,
    paths,
    absolutePaths,
    messageFile,
    rollbackSpec,
    recoveryManifest,
    commitOid,
    transactionProgress,
  };
}

function commitExact({
  vault,
  lib,
  paths,
  messageFile,
  timeoutMs,
  wrapper,
  rollbackSpec,
  recoveryManifest,
  drainer,
  progress,
  dispositions,
  commitOid,
  scanner,
  quiescenceMinutes,
}) {
  const script = [
    'set -u',
    'source "$1"',
    'vault="$2"',
    'msg="$3"',
    'wrapper="$4"',
    'spec="$5"',
    'recovery="$6"',
    'drainer="$7"',
    'progress="$8"',
    'dispositions="$9"',
    'commit_oid="${10}"',
    'scanner="${11}"',
    'quiescence="${12}"',
    'shift 12',
    'lk="$(wrap_lock "vault-$vault" 60)" || exit 70',
    'trap \'wrap_unlock "$lk" >/dev/null 2>&1 || true\' EXIT HUP INT TERM',
    'failure=""',
    'node "$drainer" --verify-progress "$progress" --dispositions "$dispositions" || failure="verify"',
    'node --input-type=module -e \'const m=await import(process.argv[2]); m.verifyTransactionSpec(process.argv[3], process.argv[4], process.argv[5], Number(process.argv[6]));\' stack-stray-library "$wrapper" "$spec" "$vault" "$scanner" "$quiescence" || failure="verify"',
    '[ -n "$failure" ] || git -C "$vault" add -- "$@" || failure="add"',
    '[ -n "$failure" ] || git -C "$vault" commit --only -F "$msg" -- "$@" || failure="commit"',
    'if [ -n "$failure" ]; then',
    '  node --input-type=module -e \'const m=await import(process.argv[2]); await m.rollbackPlacedRecords(process.argv[3], process.argv[4], process.argv[5]);\' stack-stray-library "$wrapper" "$spec" "$recovery" "$vault" || exit 73',
    '  node "$drainer" --rollback-progress "$progress" --recovery-manifest "$recovery" --dispositions "$dispositions" || exit 74',
    '  exit 72',
    'fi',
    'oid="$(git -C "$vault" rev-parse HEAD)" || exit 75',
    'printf "%s\\n" "$oid" | node --input-type=module -e \'const fs=await import("node:fs"); const m=await import(process.argv[2]); m.writePrivateReceipt(process.argv[3], fs.readFileSync(0, "utf8"), "commit receipt");\' stack-stray-library "$wrapper" "$commit_oid" || exit 75',
    'node "$drainer" --finalize-progress "$progress" --commit "$oid" --dispositions "$dispositions" || exit 75',
  ].join('\n');
  return run('/bin/bash', [
    '-c', script, '_', lib, vault, messageFile, wrapper, rollbackSpec,
    recoveryManifest, drainer, progress, dispositions, commitOid, scanner,
    String(quiescenceMinutes), ...paths,
  ], { timeoutMs });
}

export async function rollbackPlacedRecords(specPath, recoveryManifest, vault) {
  const spec = JSON.parse(readPrivate(specPath, 'rollback specification'));
  if (!spec || !Array.isArray(spec.rows) || !spec.quarantineRoot) throw new Error('invalid rollback specification');
  const root = realpathSync(vault);
  const quarantineParent = dirname(spec.quarantineRoot);
  privateDirectory(quarantineParent, 'rollback quarantine parent');
  ensurePrivateDirectory(spec.quarantineRoot, 'rollback quarantine root');
  const mappings = [];
  for (const row of spec.rows) {
    if (typeof row.recordRelative !== 'string'
        || !/^project-memory\/[^/]+\/sessions\/[^/]+\.md$/.test(row.recordRelative)) {
      throw new Error(`rollback record path is invalid for ${row.transcriptId}`);
    }
    const inputRoot = resolve(vault);
    const requestedInput = resolve(row.recordPath);
    if (!contained(requestedInput, inputRoot) || relative(inputRoot, requestedInput) !== row.recordRelative) {
      throw new Error(`rollback ownership mismatch for ${row.transcriptId}`);
    }
    const requested = join(root, row.recordRelative);
    const tracked = run('git', ['cat-file', '-e', `HEAD:${row.recordRelative}`], { cwd: root });
    if (tracked.code === 0) throw new Error(`rollback refused record already tracked in HEAD ${row.recordRelative}`);
    if (![1, 128].includes(tracked.code)) throw new Error(`rollback history check failed for ${row.recordRelative}`);
    const unstaged = run('git', ['update-index', '--force-remove', '--', row.recordRelative], { cwd: root });
    if (unstaged.code !== 0) throw new Error(`rollback could not clear index for ${row.recordRelative}`);
    const destination = join(spec.quarantineRoot, row.recordRelative);
    if (!contained(resolve(destination), resolve(spec.quarantineRoot))) {
      throw new Error(`rollback recovery path escaped quarantine for ${row.transcriptId}`);
    }
    const relativeParent = relative(spec.quarantineRoot, dirname(destination));
    ensurePrivateDirectoryTree(spec.quarantineRoot, relativeParent, 'rollback recovery directory');
    const sourceExists = existsSync(requested);
    const destinationExists = existsSync(destination);
    if (sourceExists && destinationExists) {
      throw new Error(`rollback found both source and recovery copies for ${row.transcriptId}`);
    }
    if (sourceExists) {
      const source = realpathSync(requested);
      if (source !== requested || sha256Private(source, 'rollback source record') !== row.recordSha256) {
        throw new Error(`rollback ownership mismatch for ${row.transcriptId}`);
      }
      renameSync(source, destination);
      fsyncDirectory(dirname(destination));
    } else if (!destinationExists) {
      throw new Error(`rollback lost both source and recovery copy for ${row.transcriptId}`);
    }
    if (sha256Private(destination, 'rollback recovery record') !== row.recordSha256) {
      throw new Error(`rollback recovery hash mismatch for ${row.transcriptId}`);
    }
    mappings.push({
      transcriptId: row.transcriptId,
      recordPath: row.recordPath,
      recoveredPath: destination,
      recordSha256: row.recordSha256,
    });
  }
  const manifestBody = `${mappings.map((row) => JSON.stringify(row)).join('\n')}\n`;
  writePrivateAtomicIfAbsent(recoveryManifest, manifestBody, 'rollback recovery manifest');
}

export function verifyTransactionSpec(specPath, vault, scanner, quiescenceMinutes, execute = run) {
  const spec = JSON.parse(readPrivate(specPath, 'transaction specification'));
  if (!spec || !Array.isArray(spec.rows)) throw new Error('invalid transaction specification');
  const root = realpathSync(vault);
  const cutoff = Date.now() - quiescenceMinutes * 60_000;
  const recordPaths = [];
  for (const row of spec.rows) {
    if (typeof row.sourcePath !== 'string' || /[\r\n]/.test(row.sourcePath)
        || typeof row.sourceSha256 !== 'string') {
      throw new Error(`invalid source proof for ${row.transcriptId}`);
    }
    const sourceStat = lstatSync(row.sourcePath);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.mtimeMs > cutoff) {
      throw new Error(`source is no longer quiet for ${row.transcriptId}`);
    }
    const open = execute('/usr/sbin/lsof', ['-t', row.sourcePath], { timeoutMs: 30_000 });
    if (open.code === 0) throw new Error(`source is open for ${row.transcriptId}`);
    if (open.code !== 1) throw new Error(`source ownership check failed for ${row.transcriptId}`);
    if (sha256StableRegular(row.sourcePath, `source for ${row.transcriptId}`) !== row.sourceSha256) {
      throw new Error(`source hash changed for ${row.transcriptId}`);
    }
    const recordPath = realpathSync(row.recordPath);
    if (!contained(recordPath, root)) throw new Error(`record escaped vault for ${row.transcriptId}`);
    if (sha256Private(recordPath, `record for ${row.transcriptId}`) !== row.recordSha256) {
      throw new Error(`record proof changed for ${row.transcriptId}`);
    }
    const tracked = execute('git', ['cat-file', '-e', `HEAD:${row.recordRelative}`], { cwd: root });
    if (tracked.code === 0) throw new Error(`record already tracked for ${row.transcriptId}`);
    const untracked = execute('git', ['ls-files', '--others', '--exclude-standard', '--', row.recordRelative], { cwd: root });
    if (untracked.code !== 0 || untracked.stdout.trim() !== row.recordRelative) {
      throw new Error(`record ownership changed for ${row.transcriptId}`);
    }
    recordPaths.push(recordPath);
  }
  scanExactRecords({ scanner, paths: recordPaths, execute });
}

export function appendPrivateLog(path, message) {
  privateDirectory(dirname(path), 'log directory');
  const line = `[${new Date().toISOString()}] ${message}\n`;
  const existed = existsSync(path);
  let fd;
  if (existed) {
    ({ fd } = openPrivateRegular(path, 'private log', constants.O_WRONLY | constants.O_APPEND));
  } else {
    fd = withPrivateUmask(() => openSync(
      path,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_EXCL
        | (constants.O_NOFOLLOW ?? 0),
      PRIVATE_FILE_MODE,
    ));
    try {
      fchmodSync(fd, PRIVATE_FILE_MODE);
      const after = fstatSync(fd);
      if (!after.isFile() || modeOf(after) !== PRIVATE_FILE_MODE) {
        throw new Error('private log is not an exact private regular file (0600)');
      }
      assertOwner(after, 'private log');
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }
  try {
    writeAll(fd, line);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (!existed) fsyncDirectory(dirname(path));
  privateRegular(path, 'private log');
  return line;
}

function logLine(path, message) {
  process.stdout.write(appendPrivateLog(path, message));
}

export function inspectPendingTransactions(logDir) {
  if (!existsSync(logDir)) return [];
  privateDirectory(logDir, 'log directory');
  const pending = [];
  for (const entry of readdirSync(logDir, { withFileTypes: true })) {
    if (!entry.name.startsWith('run-')) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error(`unsafe resumed run state: ${entry.name} is not a private run directory`);
    }
    const directory = join(logDir, entry.name);
    privateDirectory(directory, 'run directory');
    const incomplete = existsSync(join(directory, 'incomplete-progress.json'));
    if (existsSync(join(directory, 'transaction-resolution.json'))
        && (!incomplete || validateIncompleteRetirement(directory))) continue;
    const markers = {
      owner: existsSync(join(directory, 'transaction-owner.json')),
      placementJournal: existsSync(join(directory, 'placement-journal.jsonl')),
      rollbackSpec: existsSync(join(directory, 'rollback-spec.json')),
      recoveryManifest: existsSync(join(directory, 'rollback', 'recovery-manifest.jsonl')),
      commitReceipt: existsSync(join(directory, 'commit-oid.txt')),
    };
    if (Object.values(markers).some(Boolean) || incomplete) pending.push({ runId: entry.name, incomplete, ...markers });
  }
  return pending;
}

function directInvocation() {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}

async function main() {
  const argv = process.argv.slice(2);
  const configPath = process.env.STACK_STRAY_CONFIG || DEFAULT_CONFIG;
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const bounds = validateStrayDrainConfig(config.strayDrain ?? {});
  const { dryRun, idsFile, requestedLimit } = parseCoordinatorArgs(argv, bounds.maxPerRun);
  const requestedIds = idsFile ? readRequestedIds(idsFile, bounds.maxPerRun) : null;

  const projectsRoot = process.env.WRAP_PROJECTS_ROOT || join(HOME, '.claude', 'projects');
  const ledger = process.env.WRAP_LEDGER || join(HOME, '.local', 'llm-memory-wrappers', 'wrap-ledger.txt');
  const dispositions = process.env.WRAP_DISPOSITIONS
    || join(HOME, '.local', 'llm-memory-wrappers', 'transcript-dispositions.jsonl');
  const drainer = process.env.WRAP_DRAINER || join(HOME, '.claude', 'skills', 'wrap', 'lib', 'drain-strays.mjs');
  const lib = process.env.WRAP_LIB || join(HOME, '.claude', 'skills', 'wrap', 'lib', 'wrap-lib.sh');
  const scanner = process.env.WRAP_SCANNER || join(dirname(lib), 'secret-scan.mjs');
  const vault = config.vaultRoot;
  const logDir = join(config.logDir, '..', 'stray-drain');
  const logFile = join(logDir, 'stray-drain.log');
  if (!existsSync(drainer) || !lstatSync(drainer).isFile()) throw new Error(`drainer missing at ${drainer}`);
  const selfIds = new Set([
    process.env.CLAUDE_CODE_SESSION_ID,
    process.env.WRAP_SELF_SESSION_ID,
  ].filter(Boolean));
  let candidates = discoverCandidates({
    projectsRoot,
    ledgerPath: ledger,
    vaultRoot: vault,
    selfIds,
    quiescenceMinutes: bounds.quiescenceMinutes,
  });
  const selected = requestedIds
    ? selectRequestedCandidates(candidates, requestedIds)
    : candidates.slice(0, requestedLimit);
  if (dryRun) {
    const pending = inspectPendingTransactions(logDir);
    process.stdout.write(`dry run census: eligible ${candidates.length}; selected ${selected.length}; pending ${pending.length}\n`);
    return;
  }

  ensurePrivateDirectory(logDir, 'log directory');
  const resumed = resumePendingFinalizations({
    logDir,
    vault,
    lib,
    drainer,
    dispositions,
    ledgerPath: ledger,
    timeoutMs: bounds.globalDeadlineMs,
    scanner,
    quiescenceMinutes: bounds.quiescenceMinutes,
  });
  const activeOwners = resumed.filter((row) => row.status === 'owner_active');
  if (activeOwners.length) {
    throw new Error(`${activeOwners.length} active transcript transaction owner(s) still hold the scheduler lane`);
  }
  if (resumed.length) {
    logLine(logFile, `resumed ${resumed.length} transcript transaction(s)`);
  }

  candidates = discoverCandidates({
    projectsRoot,
    ledgerPath: ledger,
    vaultRoot: vault,
    selfIds,
    quiescenceMinutes: bounds.quiescenceMinutes,
  });
  let liveSelected;
  if (requestedIds) {
    const liveRequestedIds = readRequestedIds(idsFile, bounds.maxPerRun);
    liveSelected = selectRequestedCandidates(candidates, liveRequestedIds);
    assertRequestedSelectionStable(requestedIds, liveRequestedIds, selected, liveSelected);
  } else {
    liveSelected = candidates.slice(0, requestedLimit);
  }

  logLine(logFile, `${candidates.length} eligible unclaimed transcript(s); selected ${liveSelected.length}`);
  if (!liveSelected.length) return;

  const ownershipHead = run('git', ['rev-parse', 'HEAD'], { cwd: vault }).stdout.trim();
  if (!/^[a-f0-9]{40,64}$/i.test(ownershipHead)) throw new Error('vault HEAD query failed before child processing');
  const { runDirectory, listFile, progress, placementJournal } = createRunArtifacts(
    logDir,
    liveSelected,
    { vaultHead: ownershipHead },
  );

  const args = buildDrainerArgs({
    drainer,
    listFile,
    progress,
    dispositions,
    placementJournal,
    selectedCount: liveSelected.length,
    bounds,
    dryRun,
  });
  const child = run(process.execPath, args, {
    timeoutMs: bounds.globalDeadlineMs,
    env: { ...process.env, CHEAP_NO_ESCALATE: '1' },
  });
  let journalRecovery = {
    recovered: 0, released: 0, active: 0, missing: 0, unproven: 0, status: 'reconciled',
  };
  if (privateRegular(placementJournal, 'placement journal').size > 0) {
    journalRecovery = recoverPlacementJournalUnderVaultLock({
      vault,
      lib,
      drainer,
      placementJournal,
      dispositions,
      timeoutMs: bounds.globalDeadlineMs,
    });
    logLine(logFile, `placement journal recovery: ${journalRecovery.recovered} recovered; ${journalRecovery.released} released; ${journalRecovery.active} active; ${journalRecovery.missing} missing; ${journalRecovery.unproven} unproven`);
  }
  const journalRaw = readPrivate(placementJournal, 'placement journal');
  const journalPreview = parsePlacementJournalEvidence(journalRaw);
  const supplementalRows = selectReleasedClaimRows(dispositions, journalPreview.claimIntents);
  const evidence = reconcileRunEvidence({
    progressRaw: readPrivate(progress, 'progress ledger'),
    journalRaw,
    expected: liveSelected,
    supplementalRows,
  });
  const reconciliationSafe = evidenceCanRetireTransaction(evidence, journalRecovery);
  const rows = evidence.rows;
  if (evidence.missing.length || evidence.issues.length) {
    const incomplete = join(runDirectory, 'incomplete-progress.json');
    writePrivateAtomicIfAbsent(incomplete, `${JSON.stringify({
      schemaVersion: 1,
      observedAt: new Date().toISOString(),
      childFailure: child.failureReason ?? (child.code === 0 ? null : `exit_${child.code}`),
      missing: evidence.missing,
      issues: evidence.issues,
      journalActive: journalRecovery.active,
      journalMissing: journalRecovery.missing,
      journalUnproven: journalRecovery.unproven,
    })}\n`, 'incomplete progress receipt');
  }
  if (child.code !== 0) {
    logLine(logFile, `drainer returned ${child.failureReason ?? `exit_${child.code}`}; reconciling ${rows.length} complete typed row(s) before reporting incomplete outcomes`);
  }
  const mined = rows.filter((row) => row.status === 'mined');
  let transaction;
  if (mined.length) {
    transaction = materializeTransaction({
      runDirectory,
      vault,
      mined,
      beforeHead: ownershipHead,
    });
  }
  const paths = transaction?.paths ?? [];
  if (paths.length) {
    scanExactRecords({ scanner, paths: transaction.absolutePaths });
    const committed = commitExact({
      vault,
      lib,
      paths,
      messageFile: transaction.messageFile,
      timeoutMs: bounds.globalDeadlineMs,
      wrapper: fileURLToPath(import.meta.url),
      rollbackSpec: transaction.rollbackSpec,
      recoveryManifest: transaction.recoveryManifest,
      drainer,
      progress: transaction.transactionProgress,
      dispositions,
      commitOid: transaction.commitOid,
      scanner,
      quiescenceMinutes: bounds.quiescenceMinutes,
    });
    if (committed.code !== 0) {
      if (committed.code === 75 && existsSync(transaction.commitOid)) {
        throw new Error('vault commit is durable but captured disposition finalization failed');
      }
      throw new Error(`exact-path vault commit failed: ${committed.failureReason ?? `exit_${committed.code}`}`);
    }
    const after = readPrivate(transaction.commitOid, 'commit receipt').trim();
    if (!after || after === ownershipHead) throw new Error('vault commit reported success but HEAD did not advance');
    const committedPaths = run('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', after], { cwd: vault })
      .stdout.split('\n').filter(Boolean).sort();
    assertSamePaths(committedPaths, [...paths].sort());
    verifyCapturedDispositions(dispositions, mined, after);
    writeTransactionResolution(runDirectory, { status: 'captured', commit: after, records: mined.length });
    if (reconciliationSafe) retireIncompleteReceipt(runDirectory);
    logLine(logFile, `committed ${paths.length} exact record(s) at ${after}`);
  } else if (reconciliationSafe) {
    writeTransactionResolution(runDirectory, { status: 'no_placements', records: 0 });
    retireIncompleteReceipt(runDirectory);
  }

  const unknown = rows.filter((row) => row.status !== 'mined'
    && !TERMINAL_NO_RECORD.has(row.status) && !RETRYABLE.has(row.status));
  if (unknown.length) throw new Error(`unknown progress status ${unknown[0].status}`);
  const retryable = rows.filter((row) => RETRYABLE.has(row.status));
  const incompleteParts = [];
  if (retryable.length) incompleteParts.push(`${retryable.length} retryable disposition(s)`);
  if (evidence.missing.length) incompleteParts.push(`${evidence.missing.length} missing disposition(s)`);
  if (evidence.issues.length) incompleteParts.push(`${evidence.issues.length} malformed or conflicting evidence item(s)`);
  if (child.code !== 0 && !incompleteParts.length) incompleteParts.push(`drainer ${child.failureReason ?? `exit_${child.code}`}`);
  if (incompleteParts.length) {
    throw new Error(`run incomplete: ${incompleteParts.join('; ')}`);
  }
  logLine(logFile, `drain complete: ${rows.length} disposition(s)`);
}

function assertSamePaths(actual, expected) {
  if (actual.length !== expected.length || actual.some((path, index) => path !== expected[index])) {
    throw new Error(`commit path mismatch: expected ${expected.length}, received ${actual.length}`);
  }
}

if (directInvocation()) {
  main().catch((error) => {
    process.stderr.write(`stray-drain: ${error.message}\n`);
    process.exitCode = 1;
  });
}
