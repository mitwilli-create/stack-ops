import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), '../..');

function credentialNames(value, names = new Set()) {
  if (typeof value === 'string') {
    for (const match of value.matchAll(/\$\{([A-Z][A-Z0-9_]*)\}/g)) names.add(match[1]);
  } else if (Array.isArray(value)) {
    value.forEach((item) => credentialNames(item, names));
  } else if (value && typeof value === 'object') {
    Object.values(value).forEach((item) => credentialNames(item, names));
  }
  return names;
}

export async function readConnectorRegistry(configPath = resolve(repoRoot, '.mcp.json')) {
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  return Object.entries(config.mcpServers || {}).map(([name, server]) => ({
    name,
    transport: server.type || (server.command ? 'stdio' : 'unknown'),
    url: server.url || undefined,
    command: server.command || undefined,
    args: server.args || undefined,
    credentialNames: [...credentialNames(server)],
  }));
}
