import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

import { readConnectorRegistry } from './connector-registry.mjs';
import { SessionStore } from './session-store.mjs';
import { createSessionHost } from './session-host.mjs';
import { listSkillRegistry } from './context-assembler.mjs';
import { dispatchRoutedRequest } from '../router/ask-core.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const defaultStaticRoot = join(repoRoot, 'console');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(value));
}

function sendText(response, statusCode, value, contentType = 'text/plain; charset=utf-8') {
  response.writeHead(statusCode, { 'content-type': contentType, 'cache-control': 'no-store' });
  response.end(value);
}

async function readJson(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 1_000_000) throw new Error('request body is too large');
  }
  if (!body.trim()) return {};
  return JSON.parse(body);
}

function safeResult(result) {
  return {
    session: result.session,
    answer: result.answer,
    decision: result.decision,
    target: result.target,
    metadata: result.metadata,
    context: result.context
      ? { sources: result.context.sources, memories: result.context.memories, skills: result.context.skills }
      : null,
  };
}

function safeStatus(connectors, skills) {
  return {
    name: 'Stack Ops',
    memory: {
      canonicalFiles: true,
      recalledIndex: process.env.MEM0_MODE || 'platform',
    },
    connectors: connectors.map(({ name, transport, credentialNames }) => ({ name, transport, credentialNames })),
    skills: skills.map(({ name, description }) => ({ name, description })),
  };
}

async function staticFile(response, staticRoot, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  const root = resolve(staticRoot);
  const candidate = resolve(root, relative);
  if (candidate !== root && !candidate.startsWith(root + '/')) {
    sendText(response, 404, 'not found');
    return;
  }
  try {
    const content = await readFile(candidate);
    sendText(response, 200, content, MIME[extname(candidate)] || 'application/octet-stream');
  } catch (error) {
    sendText(response, error.code === 'ENOENT' ? 404 : 500, error.code === 'ENOENT' ? 'not found' : 'failed to read file');
  }
}

export function createAgentServer(options = {}) {
  const sessionHost = options.sessionHost;
  if (!sessionHost) throw new Error('agent server requires a session host');
  const connectors = options.connectors || [];
  const skills = options.skills || [];
  const staticRoot = options.staticRoot || defaultStaticRoot;

  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      const parts = url.pathname.split('/').filter(Boolean);

      if (url.pathname === '/api/status' && request.method === 'GET') {
        sendJson(response, 200, safeStatus(connectors, skills));
        return;
      }
      if (url.pathname === '/api/sessions' && request.method === 'GET') {
        sendJson(response, 200, await sessionHost.listSessions());
        return;
      }
      if (url.pathname === '/api/sessions' && request.method === 'POST') {
        const body = await readJson(request);
        sendJson(response, 201, await sessionHost.createSession(body.title));
        return;
      }
      if (parts.length === 4 && parts[0] === 'api' && parts[1] === 'sessions' && parts[3] === 'messages' && request.method === 'POST') {
        const body = await readJson(request);
        const result = await sessionHost.submit({ sessionId: parts[2], prompt: body.prompt, input: body.input || {} });
        sendJson(response, 200, safeResult(result));
        return;
      }
      if (parts.length === 3 && parts[0] === 'api' && parts[1] === 'sessions' && request.method === 'GET') {
        sendJson(response, 200, await sessionHost.getSession(parts[2]));
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        sendJson(response, 404, { error: 'API route not found' });
        return;
      }
      await staticFile(response, staticRoot, url.pathname);
    } catch (error) {
      const statusCode = error.code === 'SESSION_NOT_FOUND' ? 404 : 400;
      sendJson(response, statusCode, { error: error.message });
    }
  });
}

export async function createDefaultAgentServer() {
  const configPath = process.env.STACK_OPS_MCP_CONFIG || join(repoRoot, '.mcp.json');
  const connectors = await readConnectorRegistry(configPath);
  const stateDir = process.env.STACK_OPS_STATE_DIR
    || join(homedir(), 'Library', 'Application Support', 'Stack Ops');
  const store = new SessionStore(stateDir);
  const sessionHost = createSessionHost({ store, dispatch: dispatchRoutedRequest });
  const skills = await listSkillRegistry();
  return createAgentServer({ sessionHost, connectors, skills });
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const server = await createDefaultAgentServer();
  const port = Number(process.env.STACK_OPS_CONSOLE_PORT) || 3939;
  server.listen(port, '127.0.0.1', () => {
    console.log('Stack Ops console listening at http://127.0.0.1:' + port);
  });
}
