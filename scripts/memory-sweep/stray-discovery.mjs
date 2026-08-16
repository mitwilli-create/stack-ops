import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  sep,
} from 'node:path';

const SAFE_IDENTIFIER = /^[A-Za-z0-9._-]{1,128}$/;

function readLedgerStrict(path) {
  if (!existsSync(path)) return new Set();
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(`ledger read failed at ${path}: ${error.code ?? error.message}`);
  }
  const ids = new Set();
  for (const line of raw.split('\n')) {
    const id = line.trim();
    if (!id) continue;
    if (!SAFE_IDENTIFIER.test(id)) throw new Error('ledger contains an invalid identifier');
    ids.add(id);
  }
  return ids;
}

function contained(path, root) {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function canonicalMemoryRoute(projectDir, projectMemoryRoot) {
  const link = join(projectDir, 'memory');
  let linkStat;
  try {
    linkStat = lstatSync(link);
  } catch {
    return { ok: false, reason: 'missing-memory-link' };
  }
  if (!linkStat.isSymbolicLink()) return { ok: false, reason: 'local-memory-dir' };

  let target;
  try {
    target = realpathSync(link);
  } catch {
    return { ok: false, reason: 'broken-memory-link' };
  }
  if (!contained(target, projectMemoryRoot)) return { ok: false, reason: 'outside-vault' };
  if (target === projectMemoryRoot || dirname(target) !== projectMemoryRoot) {
    return { ok: false, reason: 'nested-memory-target' };
  }
  try {
    if (!lstatSync(target).isDirectory()) return { ok: false, reason: 'non-directory-memory-target' };
  } catch {
    return { ok: false, reason: 'broken-memory-link' };
  }
  return { ok: true, target };
}

export function discoverCandidates({
  projectsRoot,
  ledgerPath,
  vaultRoot,
  selfIds = new Set(),
  quiescenceMinutes,
  nowMs = Date.now(),
  onExcludedRoot = () => {},
}) {
  if (!Number.isSafeInteger(quiescenceMinutes) || quiescenceMinutes < 45) {
    throw new Error('quiescenceMinutes must be an integer of at least 45');
  }
  if (!(selfIds instanceof Set)) throw new Error('selfIds must be a Set');
  if (typeof onExcludedRoot !== 'function') throw new Error('onExcludedRoot must be a function');

  const root = realpathSync(projectsRoot);
  let projectMemoryRoot;
  try {
    projectMemoryRoot = realpathSync(join(vaultRoot, 'project-memory'));
  } catch {
    return [];
  }
  const claimed = readLedgerStrict(ledgerPath);
  const cutoff = nowMs - quiescenceMinutes * 60_000;
  const out = [];

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const projectDir = join(root, entry.name);
    const route = canonicalMemoryRoute(projectDir, projectMemoryRoot);
    if (!route.ok) {
      onExcludedRoot({ project: entry.name, reason: route.reason });
      continue;
    }

    const dirsToSearch = [projectDir];
    if (route.target && route.target !== projectDir) {
      dirsToSearch.push(route.target);
    }

    for (const searchDir of dirsToSearch) {
      for (const file of readdirSync(searchDir, { withFileTypes: true })) {
        if (!file.isFile() || file.isSymbolicLink() || !file.name.endsWith('.jsonl')) continue;
        const id = basename(file.name, '.jsonl');
        if (!SAFE_IDENTIFIER.test(id) || claimed.has(id) || selfIds.has(id)) continue;

        const path = join(searchDir, file.name);
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.mtimeMs > cutoff) continue;
        let real;
        try {
          real = realpathSync(path);
        } catch {
          continue;
        }
        if (real !== path || (!contained(real, root) && !contained(real, projectMemoryRoot))) continue;
        
        // Prevent duplicates if same file found somehow
        if (!out.some(o => o.path === path)) {
          out.push({ id, path, mtimeMs: stat.mtimeMs, size: stat.size });
        }
      }
    }
  }

  out.sort((left, right) => right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path));
  return out;
}
