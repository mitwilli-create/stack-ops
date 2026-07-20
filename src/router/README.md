# Router substrate

The triage layer that sits behind Cursor's single "Override OpenAI Base URL" and
sends each request to the model/tool research proved best for it, while keeping
sensitive content off third-party providers.

## Pieces

| File | Role |
|---|---|
| `privacy-gate.mjs` | **Content-level privacy gate.** Per-request signal check → route `anthropic-direct` (trusted) or `auto` (cheap external). Deny-by-default; pure/sync/no-network. |
| `openrouter-auto.mjs` | Endpoint config + `resolveTarget()` mapping a gate decision to a concrete forwarding target (OpenRouter Auto vs Anthropic-direct). Encodes the Cursor topology + SSRF note. |
| `pr-reviewer-triage.mjs` | **PR-reviewer triage** on the same substrate: routes a PR to CodeRabbit (always-on) ± Greptile ± Qodo by diff size, files, risk labels, repo tier. |
| `cli.mjs` | Inspect the decision for a request (`npm run gate`). |
| `router.test.mjs` | Tests (`npm test`). |
| `../../private/router-config.mjs` | **Gitignored.** Mitchell's specific private paths / employer markers / PII. Patterns only, never secret values. The gate works without it (generic defaults are safe). |

## The gate (why content-level)

The old rule was blanket-repo: "career-ops / relocation-os / anything with employer
code → always trusted provider." The evolved rule is **content-level**:

- a request that contains **secrets/keys, PII, private paths, or employer-proprietary
  markers** → `anthropic-direct` (no third-party hop);
- everything else → `auto` (OpenRouter Auto, cheap).

This is **safer** (catches sensitive content in *any* repo, including generic ones)
and **cheaper** (generic work routes cheap even inside a sensitive repo). On any
ambiguity (empty/malformed request, unrecognized route) it **denies by default**
to the trusted provider. The safe error is over-denying, never leaking.

Employer-proprietary is time-relevant (Google access ends 2026-08-23) but keeps
denying afterward. Confidentiality obligations survive the access-end date.

## Topology (Run-3 Cursor deploy)

```
Cursor ── base-URL override ──► local router (tunnel / Tailscale MagicDNS host)
                                    │  privacy-gate.classify()
                                    ├─ sensitive → Anthropic-direct
                                    └─ generic   → OpenRouter Auto (openrouter/auto)
```

Cursor issues base-URL requests **server-side**, so it SSRF-blocks raw
`localhost`/private IPs. Expose the local router via a Cloudflare tunnel or a
Tailscale MagicDNS hostname, never `http://127.0.0.1:PORT`. For Agent mode, use
OpenRouter's `/api/v1/cursor` endpoint so the tool-call payload shape doesn't
hard-fail. (`cursorBaseUrl()` enforces the no-localhost rule.)

## Try it

```bash
npm test
node src/router/cli.mjs --text "refactor this loop into a map"      # → auto
node src/router/cli.mjs --text "open ~/.secrets/api-keys.env"       # → anthropic-direct
```
