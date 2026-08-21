import { discoverCandidates } from './scripts/memory-sweep/stray-discovery.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fs from 'node:fs';

const root = mkdtempSync(join(tmpdir(), 'defect-'));
const projectsRoot = join(root, 'projects');
const vaultRoot = join(root, 'vault');
mkdirSync(projectsRoot);
mkdirSync(vaultRoot);
mkdirSync(join(vaultRoot, 'project-memory'));
const proj = join(projectsRoot, 'proj1');
mkdirSync(proj);
const target = join(vaultRoot, 'project-memory', 'proj1');
mkdirSync(target);
symlinkSync(target, join(proj, 'memory'));

const ledgerPath = join(root, 'ledger.txt');
writeFileSync(ledgerPath, '');

const p = join(target, 'valid.jsonl');
writeFileSync(p, '{}');

// Monkey patch lstatSync to simulate TOCTOU deletion
const originalLstatSync = fs.lstatSync;
fs.lstatSync = (path, ...args) => {
  if (path === p) {
    fs.unlinkSync(p); // Delete before stat!
  }
  return originalLstatSync(path, ...args);
};

try {
  discoverCandidates({
    projectsRoot,
    ledgerPath,
    vaultRoot,
    quiescenceMinutes: 45
  });
  console.log("SUCCESS");
} catch(e) {
  console.log("CRASH:", e.message);
}
