import { discoverCandidates } from './scripts/memory-sweep/stray-discovery.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
const modified = new Date(Date.now() - 120 * 60_000);
utimesSync(p, modified, modified);

const found = discoverCandidates({
  projectsRoot,
  ledgerPath,
  vaultRoot,
  quiescenceMinutes: 45
});
console.log("FOUND:", found);
