// guards.mjs: commit-time safety scanner for the nightly hygiene runner.
//
// Standing rule (global CLAUDE.md): cv.md, applications.md, hm-intel/ and
// apply-pack/ are personal data and are NEVER committed. .gitignore already
// covers them in career-ops, but a gitignore gap is exactly how an unattended
// job leaks. This is the second gate, and it is path-based AND content-based.
//
// Every function here is pure and synchronous so it can be unit-tested without
// touching git.

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Paths that must never be staged, matched against the repo-relative path. */
export const DENY_PATH_PATTERNS = [
  /(^|\/)cv\.md$/i,
  /(^|\/)applications\.md$/i,
  /(^|\/)hm-intel(\/|$)/i,
  /(^|\/)apply-pack(\/|$)/i,
  /(^|\/)interview-prep(\/|$)/i,
  /(^|\/)\.secrets(\/|$)/i,
  /(^|\/)\.env($|\.)/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/i,
  /\.(pem|p12|pfx|keystore)$/i,
  /(^|\/)credentials?\.json$/i,
  /(^|\/)service-account.*\.json$/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.netrc$/i,
];

/** Secret shapes scanned inside the staged content of text files. */
export const DENY_CONTENT_PATTERNS = [
  { name: 'anthropic-api-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'openai-api-key', re: /\bsk-(?:proj-)?[A-Za-z0-9]{32,}/ },
  { name: 'github-token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/ },
  { name: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'slack-token', re: /\bxox[abposr]-[0-9A-Za-z-]{10,}/ },
  { name: 'private-key-block', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: 'perplexity-key', re: /\bpplx-[A-Za-z0-9]{32,}/ },
  { name: 'xai-key', re: /\bxai-[A-Za-z0-9]{32,}/ },
];

/** Files above this size are not content-scanned (binary/asset heuristic). */
export const MAX_SCAN_BYTES = 2 * 1024 * 1024;

const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz',
  '.mov', '.mp4', '.mp3', '.wav', '.woff', '.woff2', '.ttf', '.otf', '.sqlite',
]);

function extOf(p) {
  const i = p.lastIndexOf('.');
  return i === -1 ? '' : p.slice(i).toLowerCase();
}

/**
 * @param {string} relPath repo-relative path
 * @returns {{blocked: boolean, reason?: string}}
 */
export function checkPath(relPath) {
  for (const re of DENY_PATH_PATTERNS) {
    if (re.test(relPath)) {
      return { blocked: true, reason: `path matches deny pattern ${re}` };
    }
  }
  return { blocked: false };
}

/**
 * @param {string} repoDir absolute repo root
 * @param {string} relPath repo-relative path
 * @returns {{blocked: boolean, reason?: string}}
 */
export function checkContent(repoDir, relPath) {
  if (BINARY_EXT.has(extOf(relPath))) return { blocked: false };
  const abs = join(repoDir, relPath);
  let size;
  try {
    size = statSync(abs).size;
  } catch {
    return { blocked: false }; // deleted file, nothing to scan
  }
  if (size > MAX_SCAN_BYTES) return { blocked: false };

  let text;
  try {
    text = readFileSync(abs, 'utf8');
  } catch {
    return { blocked: false };
  }
  // A NUL byte in the first few KB means binary; do not regex-scan it.
  for (let i = 0, n = Math.min(text.length, 8192); i < n; i++) {
    if (text.charCodeAt(i) === 0) return { blocked: false };
  }

  for (const { name, re } of DENY_CONTENT_PATTERNS) {
    if (re.test(text)) {
      return { blocked: true, reason: `content matches secret pattern: ${name}` };
    }
  }
  return { blocked: false };
}

/**
 * Screen a candidate staging set.
 * @param {string} repoDir
 * @param {string[]} relPaths
 * @returns {{allowed: string[], blocked: Array<{path: string, reason: string}>}}
 */
export function screen(repoDir, relPaths) {
  const allowed = [];
  const blocked = [];
  for (const p of relPaths) {
    const byPath = checkPath(p);
    if (byPath.blocked) {
      blocked.push({ path: p, reason: byPath.reason });
      continue;
    }
    const byContent = checkContent(repoDir, p);
    if (byContent.blocked) {
      blocked.push({ path: p, reason: byContent.reason });
      continue;
    }
    allowed.push(p);
  }
  return { allowed, blocked };
}
