#!/usr/bin/env node
// Measure a stdio MCP server's real tool-schema footprint.
// Speaks raw MCP over stdio: initialize -> notifications/initialized -> tools/list.
// Reports tool count + serialized schema bytes + a token estimate (bytes/4).
// Failure is reported as an ERROR row, never as zero, so the probe can go red.

import { spawn } from 'node:child_process';

const TIMEOUT_MS = 90_000;

async function probe({ name, command, args, env }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        env: { ...process.env, ...(env || {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      return resolve({ name, error: `spawn failed: ${e.message}` });
    }

    let buf = '';
    let stderr = '';
    let done = false;

    const finish = (result) => {
      if (done) return;
      done = true;
      try { child.kill('SIGKILL'); } catch {}
      resolve(result);
    };

    const timer = setTimeout(
      () => finish({ name, error: `timeout after ${TIMEOUT_MS}ms`, stderr: stderr.slice(-400) }),
      TIMEOUT_MS
    );

    const send = (msg) => {
      try { child.stdin.write(JSON.stringify(msg) + '\n'); } catch {}
    };

    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (e) => { clearTimeout(timer); finish({ name, error: `proc error: ${e.message}` }); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      finish({ name, error: `exited early (code ${code})`, stderr: stderr.slice(-400) });
    });

    child.stdout.on('data', (d) => {
      buf += d.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }

        if (msg.id === 1) {
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        }

        if (msg.id === 2) {
          clearTimeout(timer);
          // Assert the shape rather than assuming it. A missing `tools` array
          // must surface as an error, not as a silent count of 0.
          const tools = msg?.result?.tools;
          if (!Array.isArray(tools)) {
            return finish({
              name,
              error: `tools/list returned no tools array: ${JSON.stringify(msg).slice(0, 300)}`,
            });
          }
          const bytes = Buffer.byteLength(JSON.stringify(tools), 'utf8');
          return finish({
            name,
            count: tools.length,
            bytes,
            approxTokens: Math.round(bytes / 4),
            names: tools.map((t) => t.name),
          });
        }
      }
    });

    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'footprint-probe', version: '1.0.0' },
      },
    });
  });
}

const targets = JSON.parse(process.argv[2]);
const results = [];
for (const t of targets) {
  process.stderr.write(`probing ${t.name}...\n`);
  results.push(await probe(t));
}
console.log(JSON.stringify(results, null, 2));
