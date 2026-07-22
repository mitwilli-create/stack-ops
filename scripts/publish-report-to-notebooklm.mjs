#!/usr/bin/env node
/**
 * scripts/publish-report-to-notebooklm.mjs
 *
 * Publishes a finished research report into a named NotebookLM notebook, so
 * every council pass and every dealbreaker pass lands in a durable, queryable
 * corpus instead of only on disk.
 *
 * Routing (by notebook TITLE, never by hardcoded ID, so this file stays safe
 * in a public repo and self-heals if a notebook is recreated):
 *   council-of-models reports  ->  "Council Reports"
 *   dealbreaker reports        ->  "Dealbreaker Reports"
 *
 * Usage:
 *   node scripts/publish-report-to-notebooklm.mjs \
 *     --report /abs/path/to/report.md \
 *     --notebook "Council Reports" \
 *     [--title "Custom source title"] \
 *     [--strict]
 *
 * SOFT-FAIL BY DEFAULT. This is a side-channel archival step, not the point of
 * the run. If NotebookLM is unreachable, the session is unauthenticated, or the
 * upload fails, this exits 0 with a loud stderr warning so the calling agent
 * still returns its report. Pass --strict to exit non-zero instead. This
 * mirrors the mem0 client's soft-fail posture for the same reason: an archival
 * dependency must never be able to fail a research pass.
 *
 * Auth is a browser session written by `notebooklm login`, at
 * ~/.notebooklm/profiles/<profile>/storage_state.json. No key lives here.
 *
 * DEPENDENCY WARNING: notebooklm-py is an UNOFFICIAL client riding undocumented
 * Google endpoints. It can break without notice. That is precisely why this
 * step soft-fails.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { homedir } from 'node:os';

const STRICT = process.argv.includes('--strict');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : null;
}

/** Soft-fail exit. Loud on stderr, quiet on exit code unless --strict. */
function bail(msg) {
  console.error(`publish-to-notebooklm: ${msg}`);
  if (STRICT) process.exit(1);
  console.error('publish-to-notebooklm: soft-fail, continuing. The report on disk is unaffected.');
  process.exit(0);
}

// The CLI ships in an isolated venv. Prefer PATH, fall back to the known venv
// path, because agents do not always inherit an interactive shell's PATH.
function findCli() {
  const candidates = [
    `${homedir()}/.local/bin/notebooklm`,
    `${homedir()}/.local/venvs/notebooklm/bin/notebooklm`,
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  try {
    return execFileSync('which', ['notebooklm'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function run(cli, args, timeoutMs = 180_000) {
  return execFileSync(cli, args, { encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] });
}

const reportPath = arg('report');
const notebookTitle = arg('notebook');
const sourceTitle = arg('title');

if (!reportPath || !notebookTitle) {
  console.error('usage: --report <abs-path> --notebook "<notebook title>" [--title "<source title>"] [--strict]');
  process.exit(2); // usage errors are always hard: a typo must not silently no-op
}

const abs = resolve(reportPath);
if (!existsSync(abs)) bail(`report not found at ${abs}`);
if (!statSync(abs).isFile()) bail(`not a file: ${abs}`);

const cli = findCli();
if (!cli) bail('notebooklm CLI not found. Install: uv pip install "notebooklm-py[browser]"');

// Auth check up front so the failure message is actionable rather than a stack trace.
const sessionGlob = `${homedir()}/.notebooklm/profiles`;
if (!existsSync(sessionGlob)) bail('no NotebookLM session. Run `notebooklm login` first.');

// Resolve the notebook by title, creating it if absent. Exact match first; a
// case-insensitive match is accepted as a fallback so a manual rename with
// different capitalisation does not silently spawn a duplicate notebook.
let notebookId = null;
try {
  const listed = JSON.parse(run(cli, ['list', '--json'], 60_000));
  const books = listed.notebooks || [];
  const exact = books.find((b) => b.title === notebookTitle);
  const loose = books.find((b) => (b.title || '').toLowerCase() === notebookTitle.toLowerCase());
  notebookId = (exact || loose)?.id || null;
} catch (e) {
  bail(`could not list notebooks: ${e.message}`);
}

if (!notebookId) {
  try {
    const created = run(cli, ['create', notebookTitle], 60_000);
    const m = created.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    if (!m) bail(`created "${notebookTitle}" but could not parse its id from: ${created.trim()}`);
    notebookId = m[1];
    console.error(`publish-to-notebooklm: created missing notebook "${notebookTitle}" (${notebookId})`);
  } catch (e) {
    bail(`could not create notebook "${notebookTitle}": ${e.message}`);
  }
}

// Upload. --type file is explicit rather than auto-detected: a path that has
// gone missing would otherwise be ingested as literal inline text, which
// silently archives the pathname instead of the report.
const title = sourceTitle || basename(abs);
let sourceId = null;
try {
  const added = run(cli, [
    'source', 'add',
    '-n', notebookId,
    '--type', 'file',
    '--title', title,
    '--timeout', '120',
    abs,
  ]);
  const m = added.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  sourceId = m ? m[1] : null;
} catch (e) {
  bail(`upload failed: ${e.stderr || e.message}`);
}

// VERIFY. An upload receipt is not proof the source indexed. Per AGENTS.md, a
// check that cannot go red is not a check: this one goes red when the id is
// absent from the notebook or its status is not ready. Observed 2026-07-22:
// `source add` returns while the source is still `processing`, so verifying
// immediately always fails. Wait for indexing first, then read the list back.
// `source wait` exits 0=ready, 1=failed/missing, 2=timeout; a non-zero exit
// throws here and falls through to the unverified branch, which is correct.
let verified = false;
let status = 'unknown';
if (sourceId) {
  try {
    run(cli, ['source', 'wait', '-n', notebookId, '--timeout', '180', sourceId], 200_000);
  } catch (e) {
    console.error(`publish-to-notebooklm: source did not reach ready state: ${e.stderr || e.message}`);
  }
}
try {
  const sources = JSON.parse(run(cli, ['source', 'list', '-n', notebookId, '--json'], 60_000));
  const rows = sources.sources || [];
  const hit = sourceId
    ? rows.find((s) => s.id === sourceId)
    : rows.find((s) => (s.title || '').includes(title));
  if (hit) {
    status = String(hit.status ?? 'unknown').toLowerCase();
    verified = status === 'ready' || status === 'enabled' || status === 'active';
  }
} catch (e) {
  console.error(`publish-to-notebooklm: uploaded but could not verify: ${e.message}`);
}

const url = `https://notebooklm.google.com/notebook/${notebookId}`;
if (verified) {
  console.log(`published: "${title}" -> ${notebookTitle} (${status})`);
  console.log(url);
} else {
  console.error(`publish-to-notebooklm: source added but NOT verified ready (status: ${status}).`);
  console.error(url);
  if (STRICT) process.exit(1);
}
