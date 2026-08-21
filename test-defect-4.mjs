import { discoverCandidates } from './scripts/memory-sweep/stray-discovery.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'defect-'));
const projectsRoot = join(root, 'projects');
const vaultRoot = join(root, 'vault');
mkdirSync(projectsRoot);
mkdirSync(vaultRoot);
const proj = join(projectsRoot, 'proj1');
mkdirSync(proj);

const ledgerPath = join(root, 'ledger.txt');
writeFileSync(ledgerPath, '');

const p2 = join(proj, 'valid2.jsonl');
writeFileSync(p2, '{}');
const modified = new Date(Date.now() - 120 * 60_000);
utimesSync(p2, modified, modified);

const found = discoverCandidates({
  projectsRoot,
  ledgerPath,
  vaultRoot,
  quiescenceMinutes: 45
});
console.log("FOUND:", found);
