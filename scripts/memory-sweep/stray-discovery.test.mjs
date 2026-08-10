import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { discoverCandidates } from './stray-discovery.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'stray-discovery-'));
  const projectsRoot = join(root, 'projects');
  const vaultRoot = join(root, 'vault');
  const projectMemoryRoot = join(vaultRoot, 'project-memory');
  mkdirSync(projectsRoot, { recursive: true });
  mkdirSync(projectMemoryRoot, { recursive: true });
  const ledgerPath = join(root, 'ledger.txt');
  writeFileSync(ledgerPath, '');
  return {
    root,
    projectsRoot,
    vaultRoot,
    projectMemoryRoot,
    ledgerPath,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function project(f, name, route = 'canonical') {
  const directory = join(f.projectsRoot, name);
  mkdirSync(directory, { recursive: true });
  if (route === 'canonical') {
    const target = join(f.projectMemoryRoot, name);
    mkdirSync(target, { recursive: true });
    symlinkSync(target, join(directory, 'memory'));
  } else if (route === 'local') {
    mkdirSync(join(directory, 'memory'));
  } else if (route === 'outside') {
    const target = join(f.root, 'outside-memory', name);
    mkdirSync(target, { recursive: true });
    symlinkSync(target, join(directory, 'memory'));
  } else if (route === 'nested') {
    const target = join(f.projectMemoryRoot, name, 'nested');
    mkdirSync(target, { recursive: true });
    symlinkSync(target, join(directory, 'memory'));
  } else if (route === 'broken') {
    symlinkSync(join(f.root, 'missing', name), join(directory, 'memory'));
  }
  return directory;
}

function transcript(directory, id, ageMinutes = 120) {
  const path = join(directory, `${id}.jsonl`);
  writeFileSync(path, '{}\n');
  const modified = new Date(Date.now() - ageMinutes * 60_000);
  utimesSync(path, modified, modified);
  return path;
}

test('discovery admits only direct canonical vault memory symlink roots', () => {
  const f = fixture();
  try {
    transcript(project(f, 'canonical'), 'canonical-id');
    transcript(project(f, 'generated', 'missing'), 'generated-id');
    transcript(project(f, 'local', 'local'), 'local-id');
    transcript(project(f, 'outside', 'outside'), 'outside-id');
    transcript(project(f, 'nested', 'nested'), 'nested-id');
    transcript(project(f, 'broken', 'broken'), 'broken-id');

    const excluded = [];
    const found = discoverCandidates({
      projectsRoot: f.projectsRoot,
      ledgerPath: f.ledgerPath,
      vaultRoot: f.vaultRoot,
      quiescenceMinutes: 45,
      onExcludedRoot: (row) => excluded.push(row),
    });

    assert.deepEqual(found.map(({ id }) => id), ['canonical-id']);
    assert.equal(excluded.length, 5);
    assert.deepEqual(
      [...new Set(excluded.map(({ reason }) => reason))].sort(),
      ['broken-memory-link', 'local-memory-dir', 'missing-memory-link', 'nested-memory-target', 'outside-vault'],
    );
  } finally {
    f.cleanup();
  }
});

test('discovery filters claimed, self-owned, and recent canonical transcripts', () => {
  const f = fixture();
  try {
    const directory = project(f, 'canonical');
    transcript(directory, 'eligible-id');
    transcript(directory, 'claimed-id');
    transcript(directory, 'self-id');
    transcript(directory, 'recent-id', 5);
    writeFileSync(f.ledgerPath, 'claimed-id\n');

    const found = discoverCandidates({
      projectsRoot: f.projectsRoot,
      ledgerPath: f.ledgerPath,
      vaultRoot: f.vaultRoot,
      selfIds: new Set(['self-id']),
      quiescenceMinutes: 45,
    });

    assert.deepEqual(found.map(({ id }) => id), ['eligible-id']);
  } finally {
    f.cleanup();
  }
});

test('malformed ledger input fails closed', () => {
  const f = fixture();
  try {
    transcript(project(f, 'canonical'), 'eligible-id');
    writeFileSync(f.ledgerPath, 'bad identifier with spaces\n');
    assert.throws(
      () => discoverCandidates({
        projectsRoot: f.projectsRoot,
        ledgerPath: f.ledgerPath,
        vaultRoot: f.vaultRoot,
        quiescenceMinutes: 45,
      }),
      /ledger contains an invalid identifier/,
    );
  } finally {
    f.cleanup();
  }
});
