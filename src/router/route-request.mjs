#!/usr/bin/env node
/** Print the deterministic Stack Ops routing decision for one request. */
import { routeRequest } from './request-router.mjs';

function parseArgs(argv) {
  const out = { paths: [], attachments: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--text') out.text = argv[++i] || '';
    else if (arg === '--paths') out.paths = (argv[++i] || '').split(',').filter(Boolean);
    else if (arg === '--cwd') out.cwd = argv[++i];
    else if (arg === '--repo') out.repo = argv[++i];
    else if (arg === '--kind') out.kind = argv[++i];
    else if (arg === '--task') out.taskType = argv[++i];
  }
  return out;
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  let value = '';
  for await (const chunk of process.stdin) value += chunk;
  return value.trim();
}

const input = parseArgs(process.argv.slice(2));
if (!input.text) input.text = await readStdin();
const decision = await routeRequest(input);
console.log(JSON.stringify(decision, null, 2));
