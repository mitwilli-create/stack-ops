#!/usr/bin/env node
/**
 * cli.mjs — inspect the router substrate's decision for a request.
 *
 *   echo "refactor this loop" | node src/router/cli.mjs
 *   node src/router/cli.mjs --text "open ~/.secrets/api-keys.env"
 *   node src/router/cli.mjs --text "..." --paths career-ops/lib/x.mjs --agent
 *
 * Prints the privacy-gate decision + the resolved forwarding target. Loads the
 * gitignored private config if present; otherwise uses generic defaults.
 */
import { classifyAsync } from './privacy-gate.mjs';
import { resolveTarget } from './openrouter-auto.mjs';

function parseArgs(argv) {
  const out = { paths: [], agent: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--text') out.text = argv[++i];
    else if (a === '--paths') out.paths = (argv[++i] || '').split(',').filter(Boolean);
    else if (a === '--cwd') out.cwd = argv[++i];
    else if (a === '--agent') out.agent = true;
  }
  return out;
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data.trim();
}

const args = parseArgs(process.argv.slice(2));
const text = args.text || (await readStdin());
const decision = await classifyAsync({ text, paths: args.paths, cwd: args.cwd });
const target = resolveTarget(decision, { agentMode: args.agent });

console.log(JSON.stringify({ decision, target }, null, 2));
