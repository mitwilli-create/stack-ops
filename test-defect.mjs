import { discoverCandidates } from './scripts/memory-sweep/stray-discovery.mjs';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'defect-'));
const projectsRoot = join(root, 'projects');
const vaultRoot = join(root, 'vault');
mkdirSync(projectsRoot);
mkdirSync(vaultRoot);
const ledgerPath = join(root, 'ledger.txt');
writeFileSync(ledgerPath, '');

try {
  discoverCandidates({
    projectsRoot,
    ledgerPath,
    vaultRoot,
    quiescenceMinutes: 45
  });
  console.log("SUCCESS");
} catch (e) {
  console.error("CRASH:", e.message);
}
