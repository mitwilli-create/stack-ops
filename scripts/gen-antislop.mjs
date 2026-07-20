#!/usr/bin/env node
// Generate styles/VoiceOS/AntiSlop.yml from the Voice OS banned list.
//
// Ruled 2026-07-20: voice-os/data/banned_list.txt is the SINGLE SOURCE OF
// TRUTH for banned vocabulary. It is corpus-mined and curated from rejected
// drafts; the Vale rule was hand-written and had drifted (the two lists
// overlapped by only 2 of 15 entries, so each gate was blind to what the
// other caught).
//
// The source file holds LITERAL phrases only, because voice_os/qa.py's
// find_banned() applies re.escape() to every entry. This script escapes them
// for Vale and adds an English morphology suffix group to single words, which
// is what the old hand-written regexes (seamless(ly)?, unlock(s|ing)?) were
// doing by hand.
//
// Path is config, not code: stack-ops is public-bound and must carry no
// private paths. Same split as COUNCIL_ENGINE_PATH.
//   VOICE_OS_BANNED=/path/to/banned_list.txt node scripts/gen-antislop.mjs
// Run with --check to verify the committed rule matches the source (used by
// scripts/lint-prose.sh) instead of rewriting it.

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE =
  process.env.VOICE_OS_BANNED ||
  join(homedir(), 'Documents', 'voice-os', 'data', 'banned_list.txt');
const TARGET = join(REPO, 'styles', 'VoiceOS', 'AntiSlop.yml');

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Vale's existence matcher does NOT normalize apostrophes: a token written
// with ASCII ' (U+0027) never matches text using the typographic ' (U+2019),
// which is what editors autocorrect to by default. The source list is ASCII,
// so every apostrophe becomes a character class. Apply AFTER escapeRe; the
// YAML single-quote doubling below then wraps it correctly.
const flexApostrophe = (s) => s.replace(/'/g, "['’]");

function buildTokens(raw) {
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((phrase) => {
      const esc = flexApostrophe(escapeRe(phrase));
      // Single words take a morphology group; multi-word phrases are matched
      // as written, since "circle backing" is not a thing.
      return /\s/.test(phrase) ? esc : `${esc}(s|es|ed|ing|ly)?`;
    });
}

let source;
try {
  source = readFileSync(SOURCE, 'utf8');
} catch {
  console.error(
    `gen-antislop: cannot read ${SOURCE}\n` +
      'Set VOICE_OS_BANNED to the Voice OS banned_list.txt path.'
  );
  process.exit(2);
}

const tokens = buildTokens(source);
if (tokens.length === 0) {
  console.error('gen-antislop: source list is empty, refusing to write');
  process.exit(2);
}

const yaml = `# GENERATED FILE, DO NOT EDIT BY HAND.
# Source: voice-os/data/banned_list.txt (the single source of truth).
# Regenerate: node scripts/gen-antislop.mjs
# Verify:     node scripts/gen-antislop.mjs --check
extends: existence
message: "Anti-slop: '%s' reads as hype/slop or a banned word. Cut it or replace with a concrete fact or trade-off."
# error, not warning: Vale exits 0 on warnings, so a warning-level rule prints
# violations and then lets scripts/lint-prose.sh report PASS. Matches EmDash.yml.
level: error
ignorecase: true
tokens:
${tokens.map((t) => `  - '${t.replace(/'/g, "''")}'`).join('\n')}
`;

if (process.argv.includes('--check')) {
  const current = (() => {
    try {
      return readFileSync(TARGET, 'utf8');
    } catch {
      return null;
    }
  })();
  if (current !== yaml) {
    console.error(
      `gen-antislop: ${TARGET} is out of sync with ${SOURCE}\n` +
        'Run: node scripts/gen-antislop.mjs'
    );
    process.exit(1);
  }
  console.log(`gen-antislop: in sync (${tokens.length} tokens)`);
  process.exit(0);
}

writeFileSync(TARGET, yaml);
console.log(`gen-antislop: wrote ${tokens.length} tokens to ${TARGET}`);
