#!/usr/bin/env node
/**
 * CLI adapter behind the Raycast Stack Ops command.
 *
 * The shared runAsk seam assembles memory and skills before dispatch, while
 * local deterministic handlers answer clock questions without spending.
 */
import { runAsk } from './ask-core.mjs';

function parseArgs(argv) {
  const out = { paths: [], dryRun: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--text') out.text = argv[++i] || '';
    else if (arg === '--paths') out.paths = (argv[++i] || '').split(',').filter(Boolean);
    else if (arg === '--cwd') out.cwd = argv[++i];
    else if (arg === '--repo') out.repo = argv[++i];
    else if (arg === '--kind') out.kind = argv[++i];
    else if (arg === '--task') out.taskType = argv[++i];
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--json') out.json = true;
  }
  return out;
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  let value = '';
  for await (const chunk of process.stdin) value += chunk;
  return value;
}

function safeJson(result) {
  return {
    decision: result.decision,
    target: result.target,
    local: result.local,
    refused: result.refused || false,
    context: result.context
      ? { sources: result.context.sources, skills: result.context.skills }
      : null,
    answer: result.answer,
  };
}

const input = parseArgs(process.argv.slice(2));
const stdin = await readStdin();

try {
  const result = await runAsk({ ...input, stdin });
  if (input.json || input.dryRun) {
    console.log(JSON.stringify(safeJson(result), null, 2));
    process.exitCode = result.refused ? 3 : 0;
  } else if (result.refused) {
    console.error('Stack Ops kept this request local. ' + result.decision.note);
    process.exitCode = 3;
  } else {
    console.log('Stack Ops route: ' + result.decision.lane + ' / ' + result.decision.taskType + ' / ' + result.target.handle);
    console.log('Signals: ' + (result.decision.signals || []).join(', '));
    console.log('');
    process.stdout.write(result.answer.endsWith('\n') ? result.answer : result.answer + '\n');
  }
} catch (error) {
  console.error('Stack Ops dispatch failed: ' + error.message);
  process.exitCode = 4;
}
