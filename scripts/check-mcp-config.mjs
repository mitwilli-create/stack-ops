#!/usr/bin/env node
/**
 * check-mcp-config.mjs: preflight validator for MCP config files.
 *
 * Why this exists: on 2026-07-20 a freshly written .mcp.json referenced three
 * environment variables that were not set (GITHUB_TOKEN, PROJECT_ROOT,
 * COUNCIL_ENGINE_PATH). Nothing errored. `${PROJECT_ROOT}` was passed to the
 * server as the LITERAL STRING, so the server would have started and quietly
 * operated on a nonexistent path. The only reason it was caught was running
 * `claude mcp list` by hand and reading the warnings.
 *
 * A config that is wrong but silent is the same failure class this repo already
 * warns about for verifications: it cannot go red on its own. This makes it go red.
 *
 * Checks, per server:
 *   1. ${VAR} references resolve to a set, non-empty environment variable
 *   2. stdio `command` exists on PATH
 *   3. relative `args` paths that look like files exist on disk
 *   4. `url` is a real URL, not an unresolved <placeholder>
 *   5. the file is valid JSON with an mcpServers object
 *
 * Keys whose NAME implies a secret are checked for PRESENCE only. The value is
 * never read, printed, or logged.
 *
 * Usage:
 *   node scripts/check-mcp-config.mjs [path ...]     (default: ./.mcp.json)
 *   node scripts/check-mcp-config.mjs --self-test    (proves the check can fail)
 *
 * Exit 0 = all good. Exit 1 = at least one problem. Exit 2 = could not run.
 */
import { readFileSync, existsSync, statSync, writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname, isAbsolute, join, basename } from 'node:path';
import { tmpdir } from 'node:os';

const VAR_RE = /\$\{([A-Z0-9_]+)\}/g;

/** Sections that document rather than configure. Skipped, not validated. */
const isDocKey = (k) => k.startsWith('_');

function commandOnPath(cmd) {
  // No shell: passing args with shell:true concatenates rather than escapes,
  // and `cmd` comes from a config file.
  try {
    execFileSync('/usr/bin/env', ['sh', '-c', 'command -v "$1"', 'sh', cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function collectVars(value, found = new Set()) {
  if (typeof value === 'string') {
    for (const m of value.matchAll(VAR_RE)) found.add(m[1]);
  } else if (Array.isArray(value)) {
    value.forEach((v) => collectVars(v, found));
  } else if (value && typeof value === 'object') {
    Object.values(value).forEach((v) => collectVars(v, found));
  }
  return found;
}

/** Validate one config file. Returns an array of problem strings. */
export function checkConfig(path, env = process.env) {
  const problems = [];
  let doc;

  try {
    doc = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    return [`${path}: not valid JSON (${e.message})`];
  }

  const servers = doc.mcpServers;
  if (!servers || typeof servers !== 'object') {
    return [`${path}: no mcpServers object`];
  }

  // MCP clients launch stdio servers with cwd = the PROJECT ROOT, not the
  // config file's directory. For a root-level .mcp.json these are the same
  // directory; for .cursor/mcp.json (or .claude/) the root is the parent. A
  // relative script arg is valid if it resolves under any candidate root.
  const configDir = dirname(resolve(path));
  const roots = [configDir];
  if (basename(configDir).startsWith('.')) roots.push(dirname(configDir));

  for (const [name, cfg] of Object.entries(servers)) {
    if (isDocKey(name) || !cfg || typeof cfg !== 'object') continue;

    // 1. environment variable references
    for (const varName of collectVars(cfg)) {
      const val = env[varName];
      if (val === undefined || val === '') {
        problems.push(
          `${path} [${name}]: \${${varName}} is unset. The literal string "\${${varName}}" would be passed through, so the server starts but misbehaves silently.`
        );
      }
    }

    // 4. placeholder URLs
    if (typeof cfg.url === 'string') {
      if (cfg.url.includes('<') || cfg.url.includes('>')) {
        problems.push(`${path} [${name}]: url is still a placeholder: ${cfg.url}`);
      } else {
        try {
          new URL(cfg.url);
        } catch {
          problems.push(`${path} [${name}]: url is not a valid URL: ${cfg.url}`);
        }
      }
    }

    // 2. command resolves
    if (typeof cfg.command === 'string' && !commandOnPath(cfg.command)) {
      problems.push(`${path} [${name}]: command "${cfg.command}" is not on PATH`);
    }

    // 3. local script args exist
    if (Array.isArray(cfg.args)) {
      for (const arg of cfg.args) {
        if (typeof arg !== 'string') continue;
        if (!/\.(mjs|js|cjs|py|ts)$/.test(arg)) continue;
        if (arg.includes('${')) continue; // unresolved, already reported above
        const candidates = isAbsolute(arg) ? [arg] : roots.map((r) => resolve(r, arg));
        const found = candidates.some((c) => existsSync(c) && statSync(c).isFile());
        if (!found) {
          problems.push(`${path} [${name}]: script arg "${arg}" not found (looked in: ${candidates.join(', ')})`);
        }
      }
    }

    // A server with neither a command nor a url cannot start at all.
    if (!cfg.command && !cfg.url) {
      problems.push(`${path} [${name}]: has neither "command" (stdio) nor "url" (http)`);
    }
  }

  return problems;
}

/**
 * Self-test: prove each check can actually go red. Without this the validator is
 * itself an unfalsifiable check, which is the exact bug it was written to catch.
 */
function selfTest() {
  const dir = mkdtempSync(join(tmpdir(), 'mcpcheck-'));

  const cases = [
    ['unset var', { mcpServers: { a: { command: 'node', args: ['x.mjs'], env: { K: '${DEFINITELY_UNSET_VAR_XYZ}' } } } }, /is unset/],
    ['placeholder url', { mcpServers: { a: { url: 'https://<placeholder>/mcp' } } }, /placeholder/],
    ['missing command', { mcpServers: { a: { command: 'not-a-real-binary-xyz', args: [] } } }, /not on PATH/],
    ['missing script', { mcpServers: { a: { command: 'node', args: ['nope-does-not-exist.mjs'] } } }, /not found/],
    ['no transport', { mcpServers: { a: { env: {} } } }, /neither/],
  ];

  let failures = 0;
  for (const [label, doc, expect] of cases) {
    const p = join(dir, `${label.replace(/\W/g, '-')}.json`);
    writeFileSync(p, JSON.stringify(doc));
    const problems = checkConfig(p, {});
    const hit = problems.some((x) => expect.test(x));
    console.log(`  ${hit ? 'ok  ' : 'FAIL'}: "${label}" -> ${hit ? 'detected' : 'NOT DETECTED (check is dead)'}`);
    if (!hit) failures++;
  }

  // And a clean config must produce zero problems, or the check is just noisy.
  const cleanPath = join(dir, 'clean.json');
  writeFileSync(cleanPath, JSON.stringify({ mcpServers: { ok: { url: 'https://example.com/mcp' } } }));
  const cleanProblems = checkConfig(cleanPath, {});
  const cleanOk = cleanProblems.length === 0;
  console.log(`  ${cleanOk ? 'ok  ' : 'FAIL'}: "clean config" -> ${cleanOk ? 'no false positives' : JSON.stringify(cleanProblems)}`);
  if (!cleanOk) failures++;

  // A config inside a dotdir must resolve script args against the PARENT
  // (the project root), the way Cursor and Claude Code actually launch them.
  // Without this, a valid .cursor/mcp.json reports a false "script not found".
  const dotDir = join(dir, '.cursor');
  mkdirSync(dotDir, { recursive: true });
  writeFileSync(join(dir, 'server.mjs'), '// stub');
  const dotCfg = join(dotDir, 'mcp.json');
  writeFileSync(dotCfg, JSON.stringify({ mcpServers: { s: { command: 'node', args: ['server.mjs'] } } }));
  const dotProblems = checkConfig(dotCfg, { });
  // The stub command "node" resolves on PATH; the only thing under test is the
  // relative script arg, which lives at the parent, not inside .cursor.
  const dotOk = !dotProblems.some((p) => /not found/.test(p));
  console.log(`  ${dotOk ? 'ok  ' : 'FAIL'}: "dotdir resolves to project root" -> ${dotOk ? 'found via parent' : JSON.stringify(dotProblems)}`);
  if (!dotOk) failures++;

  return failures;
}

const args = process.argv.slice(2);

if (args.includes('--self-test')) {
  console.log('check-mcp-config self-test (each case MUST be detected):');
  const failures = selfTest();
  console.log(failures === 0 ? 'PASS: the validator can go red.' : `FAIL: ${failures} check(s) are dead.`);
  process.exit(failures === 0 ? 0 : 1);
}

const targets = args.length ? args : ['.mcp.json'];
const existing = targets.filter((t) => existsSync(t));

if (existing.length === 0) {
  // No config is not a failure; it means this project has no MCP wiring.
  console.log(`check-mcp-config: no config found at ${targets.join(', ')}, nothing to check.`);
  process.exit(0);
}

let total = 0;
for (const t of existing) {
  const problems = checkConfig(t);
  if (problems.length === 0) {
    console.log(`  ok: ${t}`);
  } else {
    total += problems.length;
    for (const p of problems) console.error(`  PROBLEM: ${p}`);
  }
}

if (total > 0) {
  console.error(`\ncheck-mcp-config: ${total} problem(s). These fail SILENTLY at runtime, which is why this check exists.`);
  process.exit(1);
}
console.log('check-mcp-config: clean.');
