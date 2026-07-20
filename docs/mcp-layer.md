# MCP capability layer

MCP servers are live tool/data bridges an agent (Claude Code, Cursor) calls natively.

**Revised 2026-07-20 (Session 8) against measured footprints.** Every number here was produced by
launching the real server and calling `tools/list` with `scripts/probe-mcp-footprint.mjs`. The full
audit, including the negative controls and the corrections to earlier claims, is in
`docs/mcp-cli-audit.md`.

## What changed, and why the old doctrine needs re-reading

The original rule was "a tight foundational set everywhere, because tool schemas cost context on every
request." **That premise no longer holds on Claude Code**, which defers MCP tool schemas by default and
loads roughly five relevant tools on demand.

The tool-spam discipline survives, but it now applies to a specific surface:

- **Claude Code**: deferral absorbs a large set. Breadth is close to free. Do not assume it, though;
  HTTP and streamable-HTTP servers have shipped bugs where deferral silently did not apply.
- **Cursor**: **hard ceiling of about 40 tools across all servers, no tool-search equivalent, and
  overflow fails silently** by dropping the agent's access. This is where a lean set is mandatory.
- **Anything routed through a gateway**: tool search switches off when `ANTHROPIC_BASE_URL` points at a
  non-first-party host. See the trap section in the audit.

So there are now **two profiles**, not one list: a broad Claude Code profile and a deliberately narrow
Cursor profile.

## Verdicts

Measured footprint in tokens, from the live probe.

### Keep as MCP

| Server | Tools | ~Tokens | Why it wins |
|---|---:|---:|---|
| **GitHub** (remote, read-only, `repos,pull_requests`) | 16 | 9,240 | Structured PR review threads. Configured down 68% from 44 tools / 28,918. Writes go through `gh`. |
| **Serena** | 21 | 6,320 | Semantic symbol retrieval and rename. No CLI equivalent exists. |
| **Context7** | 2 | 1,230 | Version-correct library docs. Cheapest real capability measured. |
| **Playwright** | 24 | 4,617 | UI verification, which `git-shipping-safety` requires. Project-scoped to UI repos. |
| **Cloudflare** (Code Mode) | 2 | ~1,000 (vendor claim, unverified) | Two tools (`search`, `execute`) covering 2,500+ endpoints. OAuth-gated, so the probe returned 401. |
| **ElevenLabs** | 27 | 17,363 | Voice work. Key present. Project-scoped to voice-os and content-ops. |
| **council** (own wrap) | 3 | 380 | Routing policy, read-only, no spend. Effectively free. |
| **career-ops** (own wrap) | 3 | 403 | Built Session 8. `queue_status`, `triage_next`, gated `apply_pack`. |
| **Notion** | 24 | 19,054 | Enabled 2026-07-20. Second-largest server in the set, so it stays out of the Cursor profile. Key verified live. |
| **media** (own wrap) | 4 | 626 | Built Session 8. Policy by default, spends only on explicit confirm. |

### Replaced by a CLI

| Server | Replaced by | Note |
|---|---|---|
| Filesystem | native Read/Write/Edit/Glob/Grep | 3,243 tokens for zero added capability in Claude Code. |
| Fetch | native WebFetch, `curl` | The templated npm package did not exist anyway. |
| Sequential-Thinking | native extended thinking | Superseded on a reasoning model. |
| Cloudflare (classic MCP) | `wrangler` 4.92.0, `cloudflared` 2026.3.0 | Deploys, tunnels, `d1 migrations`. Pairs with Code Mode, see below. |

### Dropped

| Server | Reason |
|---|---|
| Obsidian | Obsidian is not installed and there is no vault. The most-linked server (`MarkusPfundstein/mcp-obsidian`) is abandoned with 85 open issues, and the Smithery package 404s. If adopted later, use `@bitbonsai/mcpvault`, or just point a filesystem server at the vault, since it is a folder of Markdown. |
| Sentry | No key, no monitored production service. Re-add when one exists; it supports `?skills=` scoping to control tool count. |
| Apify | No token. 11,376 tokens, and it overlaps Firecrawl. |
| Firecrawl | No key. 17,464 tokens. |
| Exa | No key. Cheapest search server measured at 550 tokens; adopt when a key exists. |

### Own-tool wraps

| # | Server | Status |
|---|---|---|
| 1 | council | **BUILT**, `src/mcp/council-server.mjs` |
| 2 | career-ops orchestrator | **BUILT Session 8**, `src/mcp/career-ops-server.mjs` |
| 3 | media pipeline | **BUILT Session 8**, `src/mcp/media-server.mjs` |
| 4 | cloudflare-ops | **DELETED as superseded.** Cloudflare's own Code Mode MCP covers tunnel, Stream and cache operations for ~1,000 tokens. Do not build this. |
| 5 | AssemblyAI | Not needed separately. `media`'s `transcribe` routes to AssemblyAI via the media matrix. |

Public server code carries **no private paths**. Locations come from `COUNCIL_ENGINE_PATH` and
`CAREER_OPS_PATH`, or the gitignored `private/mcp-config.mjs`.

Both new wraps are **gated where they can cause an effect**: `apply_pack` writes files and refuses
without `confirm:true`; every `media` tool resolves policy only and refuses to dispatch without
`confirm:true` plus a present credential. Both gates were verified to fire.

## Cloudflare is three layers, not one choice

Per Cloudflare's own Claude Code guidance:

| Layer | Handles |
|---|---|
| Skills plugin (`/plugin marketplace add cloudflare/skills`) | persistent Cloudflare knowledge; teaches the agent when to reach for the CLI |
| Code Mode MCP (`https://mcp.cloudflare.com/mcp`) | platform operations: DNS, WAF, R2, Stream, Zero Trust |
| `wrangler` / `cloudflared` | local dev, deploys, `d1 migrations`, tunnels |

## Activation matrix

**Claude Code profile** (deferral absorbs the breadth):

| Project | Servers |
|---|---|
| stack-ops | github, serena, context7, council, notion |
| career-ops | github, serena, context7, council, career-ops, notion, Google Workspace (once configured). **Blocked: career-ops is a frozen working tree, so its `.mcp.json` was not edited.** Apply when the freeze lifts. |
| voice-os / content-ops | serena, context7, council, media, elevenlabs |
| storytellermitch.com | playwright, cloudflare (Code Mode), media |

**Cursor profile** (must stay under ~40 tools total):

| Project | Servers | Tools |
|---|---|---:|
| any | github (read-only, `repos,pull_requests`) + context7 + council | 21 |
| add for UI work | swap github out for playwright | 29 |

Do not enable Serena and Playwright and GitHub together in Cursor; that is 61 tools and Cursor will
silently drop the overflow.

## Blocked on Mitchell

These cannot be completed from a session and are listed in `private/credentials-needed.md`:

- **Google Workspace** is not a single URL. It requires enabling `gmailmcp`, `drivemcp`,
  `calendarmcp` and `chatmcp` services in a Google Cloud project, creating an OAuth client, and adding
  it to Claude as a **custom connector** through the claude.ai interface rather than through
  `.mcp.json`. Decision J's "one official remote MCP, do not build a custom wrapper" was right about
  not building a wrapper and wrong about it being one endpoint.
- **Firecrawl, Apify, Exa, Sentry** keys, if those servers are wanted.
- **Obsidian** install, if that report store is wanted.

## Verification

Re-measure any server with:

```
node scripts/probe-mcp-footprint.mjs '[{"name":"x","command":"npx","args":["-y","pkg"]}]'
```

The probe reports ERROR rows rather than zeros when a server fails to launch, times out, or returns no
tools array. Confirm it can still go red before trusting a green run. Note that the 2026-07-28 MCP spec
removes the `initialize` handshake this probe uses; new clients fall back for older servers, but the
probe will need updating when servers migrate.
