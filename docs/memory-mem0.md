# Memory layer: mem0

The persistent-memory pillar of the three-layer hygiene frame (decision E). mem0 is
the **standardized baseline, set in stone**, wired via its SDK/platform, **not** the
archived `mem0ai/mem0-mcp` server.

## Wiring

`src/memory/mem0-client.mjs` is a thin, fail-soft wrapper: `remember(text, meta)` /
`recall(query, k)` / `memoryStatus()`. Two backends, chosen by env:

| Mode | Env | Needs | Notes |
|---|---|---|---|
| Platform (default) | `MEM0_MODE=platform` | `MEM0_API_KEY` | hosted; `npm i mem0ai`. **Key is Mitchell's to add**; a value cannot be pasted here. |
| Self-host | `MEM0_MODE=oss` | a local vector store | `mem0ai/oss`; fully local, best for the content-level privacy gate's sensitive traffic. |

If the key/SDK is absent it degrades to a **no-op** (stores nothing, returns `[]`)
so callers are never broken by unconfigured memory. Treat recalled memories as
best-effort context, never as truth (they reflect what was true when written).

## Handoff to Mitchell (one step)

1. Create a mem0 platform account and generate an API key (or choose self-host).
2. Add `MEM0_API_KEY` to `~/.secrets/api-keys.env` (value-blind; Claude cannot paste it).
3. `npm i mem0ai` where the client is used.
4. Verify: `node -e "import('./src/memory/mem0-client.mjs').then(m=>m.memoryStatus().then(console.log))"` → expect `{ kind: 'platform' }`.

## Privacy interaction

Sensitive memories (anything the privacy gate would mark secret/PII/employer)
belong in the **self-host** backend, never the hosted platform. A caller that
writes potentially-sensitive content should run it through
`src/router/privacy-gate.mjs` first and route sensitive writes to `MEM0_MODE=oss`.

## mesa (deferred, not dropped)

mem0 is the reliable baseline first. `mesa` gets a fair head-to-head on Mitchell's
real corpus AFTER the stack is wired (he knows the creator). Bench both with the
same corpus + query set; compare recall quality and token cost per session.
