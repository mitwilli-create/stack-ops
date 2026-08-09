import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const ADVANCE_REASONS = new Set([
  'plan_limit',
  'rate_quota',
  'credential',
  'timeout',
  'circuit_open',
  'unavailable',
  'malformed_response',
]);

export function classifyPlannerFailure({ text = '', timedOut = false, malformed = false } = {}) {
  if (timedOut) return 'timeout';
  if (malformed) return 'malformed_response';
  const value = String(text || '').toLowerCase();
  if (/privacy/.test(value)) return 'privacy';
  if (/policy/.test(value)) return 'policy';
  if (/invalid input|input (?:failure|rejected|violation)/.test(value)) return 'input';
  if (/authorization (?:failure|rejected|violation)|\b403\b|forbidden|access denied/.test(value)) return 'authorization';
  if (/weekly limit|plan limit|usage limit/.test(value)) return 'plan_limit';
  if (/\b429\b|rate.?limit|quota|resource.?exhausted/.test(value)) return 'rate_quota';
  if (/credential|\b401\b|unauthorized|not logged in|login required/.test(value)) return 'credential';
  if (/circuit.?open/.test(value)) return 'circuit_open';
  if (/provider unavailable|temporarily unavailable|command not found|enoent|spawn .* no such file/.test(value)) return 'unavailable';
  return 'unknown';
}

function cleanSubscriptionEnvironment() {
  const env = {};
  for (const key of [
    'HOME', 'PATH', 'TMPDIR', 'TMP', 'TEMP', 'USER', 'LOGNAME', 'SHELL',
    'LANG', 'LC_ALL', 'TERM', 'COLORTERM', 'NO_COLOR',
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

function run(command, args, { cwd, timeoutMs }) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: cleanSubscriptionEnvironment(),
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutMs,
  });
  const errorCode = result.error?.code || null;
  const timedOut = errorCode === 'ETIMEDOUT';
  return {
    code: result.status === null ? (timedOut ? 124 : 127) : result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || (result.error ? String(result.error.message) : ''),
    timedOut,
    errorCode,
  };
}

function scanText(text, scanner, runDir) {
  if (!scanner?.bin || !scanner?.script) return false;
  mkdirSync(runDir, { recursive: true });
  const path = join(runDir, `.planner-scan-${process.pid}-${randomUUID()}.txt`);
  try {
    writeFileSync(path, String(text), { mode: 0o600 });
    const result = run(scanner.bin, [scanner.script, path], { cwd: runDir, timeoutMs: 30_000 });
    return result.code === 0;
  } finally {
    rmSync(path, { force: true });
  }
}

function parsePlan(text) {
  const value = String(text || '').trim();
  if (!value) return null;
  const candidates = [value];
  const match = value.match(/\{[\s\S]*\}/);
  if (match && match[0] !== value) candidates.push(match[0]);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.operations)) return parsed;
    } catch {
      // Try the next bounded candidate.
    }
  }
  return null;
}

function attempt(provider, model, status, failureReason = null) {
  return {
    requestedSlot: 'frontier-planner',
    resolvedModel: model,
    provider,
    accountType: 'subscription',
    status,
    failureReason,
  };
}

function claudePlan({ prompt, workDir, timeoutMs, candidate }) {
  const result = run(candidate.bin, [
    '-p', prompt,
    '--output-format', 'json',
    '--permission-mode', 'plan',
    '--model', candidate.model,
    '--effort', candidate.effort || 'high',
    '--disallowedTools', 'Write,Edit,NotebookEdit,Bash',
  ], { cwd: workDir, timeoutMs });
  if (result.code !== 0) {
    const failureReason = classifyPlannerFailure({
      text: `${result.stderr}\n${result.stdout}`,
      timedOut: result.timedOut,
    });
    return { ok: false, failureReason };
  }
  try {
    const envelope = JSON.parse(result.stdout);
    const plan = parsePlan(typeof envelope.result === 'string' ? envelope.result : result.stdout);
    if (!plan) return { ok: false, failureReason: 'malformed_response' };
    return { ok: true, plan, costUsd: Number(envelope.total_cost_usd) || 0 };
  } catch {
    return { ok: false, failureReason: 'malformed_response' };
  }
}

function codexPlan({ prompt, runDir, timeoutMs, candidate }) {
  mkdirSync(runDir, { recursive: true });
  const outputPath = join(runDir, `.codex-plan-${process.pid}-${randomUUID()}.json`);
  try {
    writeFileSync(outputPath, '', { mode: 0o600 });
    const result = run(candidate.bin, [
      'exec',
      '--ephemeral',
      '--ignore-user-config',
      '--model', candidate.model,
      '--sandbox', 'read-only',
      '--skip-git-repo-check',
      '--color', 'never',
      '-C', candidate.workDir,
      '-o', outputPath,
      prompt,
    ], { cwd: runDir, timeoutMs });
    if (result.code !== 0) {
      const failureReason = classifyPlannerFailure({
        text: `${result.stderr}\n${result.stdout}`,
        timedOut: result.timedOut,
      });
      return { ok: false, failureReason };
    }
    const plan = existsSync(outputPath) ? parsePlan(readFileSync(outputPath, 'utf8')) : null;
    if (!plan) return { ok: false, failureReason: 'malformed_response' };
    return { ok: true, plan, costUsd: 0 };
  } finally {
    rmSync(outputPath, { force: true });
  }
}

export function verifyCodexChatGptSubscription(candidate, { runDir, timeoutMs = 30_000 } = {}) {
  if (!candidate?.bin) return { ok: false, failureReason: 'unavailable' };
  const result = run(candidate.bin, ['login', 'status'], { cwd: runDir, timeoutMs });
  if (result.code !== 0) {
    const failureReason = classifyPlannerFailure({
      text: `${result.stderr}\n${result.stdout}`,
      timedOut: result.timedOut,
    });
    return { ok: false, failureReason: failureReason === 'unknown' ? 'account_unverified' : failureReason };
  }
  if (!/logged in using chatgpt/i.test(`${result.stdout}\n${result.stderr}`)) {
    return { ok: false, failureReason: 'account_unverified' };
  }
  return { ok: true, accountType: 'subscription' };
}

export function runSubscriptionPlan({
  prompt,
  workDir,
  runDir,
  timeoutMs,
  scanner,
  claude,
  codex,
  preflightAttempts = [],
}) {
  const attempts = [...preflightAttempts];
  const candidates = [
    { provider: 'claude-cli', candidate: claude, invoke: claudePlan, cwd: workDir },
    { provider: 'codex-cli', candidate: codex, invoke: codexPlan, cwd: runDir },
  ].filter(({ candidate }) => candidate?.bin && candidate?.model);

  if (!prompt?.trim() || candidates.length === 0) {
    return { ok: false, failureReason: 'input', attempts };
  }

  const inputIsSafeForCrossProviderReplay = scanText(prompt, scanner, runDir);

  for (const { provider, candidate, invoke } of candidates) {
    if (provider === 'codex-cli') {
      if (!inputIsSafeForCrossProviderReplay) {
        return { ok: false, failureReason: 'privacy', attempts };
      }
      const account = verifyCodexChatGptSubscription(candidate, { runDir, timeoutMs: Math.min(timeoutMs, 30_000) });
      if (!account.ok) {
        attempts.push(attempt(provider, candidate.model, 'failed', account.failureReason));
        return { ok: false, failureReason: account.failureReason, attempts };
      }
    }
    const result = invoke({
      prompt,
      workDir,
      runDir,
      timeoutMs,
      candidate: { ...candidate, workDir },
    });
    if (result.ok) {
      if (!scanText(JSON.stringify(result.plan), scanner, runDir)) {
        attempts.push(attempt(provider, candidate.model, 'failed', 'privacy'));
        return { ok: false, failureReason: 'privacy', attempts };
      }
      attempts.push(attempt(provider, candidate.model, 'succeeded'));
      return { ...result, provider, resolvedModel: candidate.model, attempts };
    }
    attempts.push(attempt(provider, candidate.model, 'failed', result.failureReason));
    if (!ADVANCE_REASONS.has(result.failureReason)) {
      return { ok: false, failureReason: result.failureReason, attempts };
    }
  }
  return {
    ok: false,
    failureReason: attempts.at(-1)?.failureReason || 'unavailable',
    attempts,
  };
}
