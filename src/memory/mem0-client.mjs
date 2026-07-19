/**
 * mem0-client.mjs — thin wrapper over mem0 (the standardized memory baseline,
 * decision E). Integrates via mem0's SDK/platform — NOT the archived
 * mem0ai/mem0-mcp server.
 *
 * Two backends, chosen by env:
 *   - PLATFORM (default): the hosted mem0 platform. Needs MEM0_API_KEY (Mitchell's
 *     to add — a key VALUE cannot be pasted here). `npm i mem0ai`.
 *   - SELF-HOST (MEM0_MODE=oss): local mem0 OSS with your own vector store.
 *
 * Fails SOFT: if the key/SDK is absent, the client degrades to a no-op memory so a
 * caller is never broken by memory being unconfigured — it just stores nothing and
 * returns []. Callers should treat memory as best-effort context, never as truth.
 *
 * mesa is DEFERRED (decision E): mem0 is the baseline; mesa gets a fair head-to-head
 * on Mitchell's real corpus AFTER the stack is wired.
 */

const USER_ID = process.env.MEM0_USER_ID || 'mitchell';

let _impl = null;

async function getImpl() {
  if (_impl) return _impl;
  const mode = process.env.MEM0_MODE || 'platform';
  try {
    if (mode === 'oss') {
      const { Memory } = await import('mem0ai/oss');
      const m = new Memory();
      _impl = {
        async add(text, meta) { return m.add(text, { userId: USER_ID, metadata: meta }); },
        async search(q, k = 5) { const r = await m.search(q, { userId: USER_ID, limit: k }); return r?.results || r || []; },
        kind: 'oss',
      };
    } else {
      if (!process.env.MEM0_API_KEY) throw new Error('MEM0_API_KEY not set');
      const { MemoryClient } = await import('mem0ai');
      const m = new MemoryClient({ apiKey: process.env.MEM0_API_KEY });
      _impl = {
        async add(text, meta) { return m.add([{ role: 'user', content: text }], { user_id: USER_ID, metadata: meta }); },
        async search(q, k = 5) { const r = await m.search(q, { user_id: USER_ID, limit: k }); return r?.results || r || []; },
        kind: 'platform',
      };
    }
  } catch (e) {
    // Fail soft — no key / SDK not installed → no-op memory.
    _impl = {
      async add() { return { skipped: true }; },
      async search() { return []; },
      kind: 'noop',
      reason: String(e.message || e),
    };
  }
  return _impl;
}

/** Store a memory. Best-effort; never throws. */
export async function remember(text, metadata = {}) {
  try { return await (await getImpl()).add(text, metadata); }
  catch { return { skipped: true }; }
}

/** Retrieve up to k relevant memories for a query. Best-effort; returns [] on failure. */
export async function recall(query, k = 5) {
  try { return await (await getImpl()).search(query, k); }
  catch { return []; }
}

/** Which backend is active: 'platform' | 'oss' | 'noop' (+ reason if noop). */
export async function memoryStatus() {
  const impl = await getImpl();
  return { kind: impl.kind, reason: impl.reason };
}
