# MCP-vs-CLI audit (Session 8, 2026-07-20)

Measured, not estimated. Every number below comes from launching the real server and calling
`tools/list`, then serializing the returned schemas (`scripts/probe-mcp-footprint.mjs`). Token figures
are `bytes / 4`, the standard approximation.

The probe was negative-controlled before any number was trusted: a nonexistent binary, a process that
exits immediately, and a process that speaks stdio but not MCP all produce ERROR rows, not zeros.
Per `AGENTS.md`: a green check that cannot go red is not a check.

## The headline finding, which reframes the whole audit

**Claude Code already solved the standing-context problem, and the brief predates the fix.**

Tool search (deferred tool loading) is **on by default**; this machine runs client **2.1.214**. Tool
definitions are withheld from context, the agent gets a summary, and up to five relevant tools are
loaded on demand. Anthropic measures ~85% token reduction, and tool-selection accuracy *improves*
(Opus 4.5: 79.5% → 88.1%).

Two corrections to what the secondary coverage says, both verified against the vendor doc:

- **The 10%-of-context threshold is NOT the default.** That is `auto` mode only. With
  `ENABLE_TOOL_SEARCH` unset, **all** MCP tools are deferred regardless of size.
- **The "since 2.1.7" attribution does not verify.** No changelog entry ties deferred loading to a
  version; it traces to a single third-party post. Early 2026 is right, the version number is not
  sourced. Do not repeat it.

So the premise "an MCP server injects its schemas on nearly every request" is **no longer true on the
Claude Code surface**. This session is itself the proof: ~200 MCP tools are attached, and they arrive
as a deferred name-only list.

That does not make the audit moot. It relocates it. Three places where footprint still bites:

1. **Cursor** has no tool search and a hard practical ceiling (~40-50 tools before selection degrades).
   The lean set is still load-bearing there, which is exactly the surface Session 8 was meant to
   protect.
2. **The `ANTHROPIC_BASE_URL` trap** (see below) can silently switch tool search off.
3. **Per-call cost still applies.** Deferral removes the *standing* cost, not the cost of a bloated
   response body once a tool is actually invoked.

## Measured footprints

Context: a 200k window. "% ctx" = share of that window if loaded upfront.

### Foundational set (decision J)

| Server | Tools | Bytes | ~Tokens | % ctx | Status |
|---|---:|---:|---:|---:|---|
| GitHub (remote, default) | 44 | 115,670 | 28,918 | 14.5% | live-probed |
| Playwright | 24 | 18,466 | 4,617 | 2.3% | live-probed |
| Serena | 21 | 25,280 | 6,320 | 3.2% | live-probed |
| Filesystem | 14 | 12,973 | 3,243 | 1.6% | live-probed |
| Context7 | 2 | 4,920 | 1,230 | 0.6% | live-probed |
| Sequential-Thinking | 1 | 4,587 | 1,147 | 0.6% | live-probed |
| Fetch | 1 | 1,104 | 276 | 0.1% | live-probed |
| **Total** | **107** | **183,000** | **45,751** | **22.9%** | |

### Domain set

| Server | Tools | ~Tokens | % ctx | Status |
|---|---:|---:|---:|---|
| ElevenLabs | 27 | 17,363 | 8.7% | live-probed |
| Firecrawl | 26 | 17,464 | 8.7% | live-probed |
| Notion | 24 | 19,054 | 9.5% | live-probed |
| Apify | 10 | 11,376 | 5.7% | live-probed |
| Sentry | 9 | 7,008 | 3.5% | live-probed |
| Exa | 2 | 550 | 0.3% | live-probed |
| Obsidian | ? | ? | ? | **could not launch** |
| Cloudflare | ? | ? | ? | **could not launch** |
| Google Workspace | ? | ? | ? | **placeholder URL in template** |
| **Measured subtotal** | **98** | **72,815** | **36.4%** | |

### Own-tool wraps

| Server | Tools | ~Tokens | % ctx | Status |
|---|---:|---:|---:|---|
| council | 3 | 380 | 0.2% | live-probed, built |

**Full decided set, as measured: 208 tools / ~118,946 tokens / 59.5% of a 200k window.**
Three servers could not be measured, so the true figure is higher.

## GitHub is the whole foundational problem

GitHub alone is 63% of the foundational footprint. It is also the one server with first-class
knobs to shrink it, and they work:

| Configuration | Tools | ~Tokens | vs default |
|---|---:|---:|---:|
| default | 44 | 28,918 | (baseline) |
| `X-MCP-Toolsets: repos,pull_requests` | 29 | 17,665 | −39% |
| `X-MCP-Readonly: true` | 27 | 16,921 | −41% |
| **both** | **16** | **9,240** | **−68%** |

Read-only is also a safety property, not only a token property: it is a strict filter that disables
write tools even when a toolset requests them. Mitchell's `gh` token carries `delete_repo`.

## Three entries in the template are broken and would fail on activation

`mcp/mcp.json.template` has never been activated, so these have never surfaced:

| Template entry | Reality |
|---|---|
| `npx @github/github-mcp-server` | **404 on npm. This package does not exist.** GitHub ships a Go binary / Docker image, plus the remote server at `https://api.githubcopilot.com/mcp/` (verified working with Mitchell's token). |
| `npx @modelcontextprotocol/server-fetch` | **404 on npm.** It is a Python package: `uvx mcp-server-fetch` (verified, 1 tool). |
| `npx apify-mcp-server` | **404 on npm.** Real name is `@apify/actors-mcp-server` (verified, 10 tools). |
| `@cloudflare/mcp-server-cloudflare` | Exists (0.2.0) but exits immediately; Cloudflare has moved to hosted remote MCP servers. |
| `google-workspace` | URL is the literal placeholder `https://<google-official-remote-mcp>`. |

## The `ANTHROPIC_BASE_URL` trap (new, and it intersects the router work)

Tool search is **disabled automatically when `ANTHROPIC_BASE_URL` points at a non-first-party host**,
because most proxies do not forward `tool_reference` blocks.

Current state is safe: `ANTHROPIC_BASE_URL=https://api.anthropic.com` (first-party), so tool search is on.

But the standing rule is "never route a flat-rate surface," and the reason recorded so far has been
billing. There is now a **second** reason: pointing Claude Code at a gateway does not just convert
subscription spend into per-token spend, it also silently turns off deferred tool loading, so every
MCP schema in the active set starts loading upfront on every request. At the measured 119k, that is
59% of the window gone before any work starts. The failure is silent in both directions.

`CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` has the same effect and cannot be overridden by
`ENABLE_TOOL_SEARCH`. Neither variable is currently set.

## CLI equivalence, verified on this machine

Installed and authenticated: `gh` (mitwilli-create), `curl`, `wrangler` 4.92.0, `cloudflared`
2026.3.0, `uvx`, `npx`, `jq`, `vale`.
Missing: `sentry-cli`, `gcalcli`, `ccusage` (D5 item B-wired claims ccusage is wired, but **it is not on
PATH**; that is a stale-brief correction).

| Capability | MCP cost | CLI path | Assessment |
|---|---:|---|---|
| GitHub | 28,918 | `gh`, installed and authed, full API via `gh api` | CLI covers it; MCP's edge is structured PR-review threads |
| Filesystem | 3,243 | native Read/Write/Edit/Glob/Grep | **strictly redundant** in Claude Code |
| Fetch | 276 | native WebFetch / `curl` | **strictly redundant**; cost is trivial either way |
| Sequential-Thinking | 1,147 | native extended thinking | **redundant** on a reasoning model |
| Cloudflare | ? | `wrangler` + `cloudflared`, both installed | CLI is the mature path |
| Sentry | 7,008 | `sentry-cli` (not installed) | neither path is wired today |
| Obsidian | ? | `rg`/`grep` over the vault, which is just markdown files | CLI is simpler and has no plugin dependency |
| Notion | 19,054 | API script | MCP wins on auth; cost is high |
| Google Workspace | ? | `gcalcli` (not installed) | OAuth genuinely favors the official remote MCP |
| Serena | 6,320 | no equivalent | **MCP wins**: semantic symbol retrieval |
| Context7 | 1,230 | no equivalent | **MCP wins**: cheapest server measured, real capability |
| Playwright | 4,617 | Playwright CLI exists but is not agent-shaped | **MCP wins** for UI verification |
| council | 380 | `run-council.mjs` | already both; keep the wrap, it is nearly free |

## Deferral is not reliably applied, which changes the GitHub answer

A research pass over closed Claude Code issues (all twelve issue numbers verified against the live
GitHub API) found that deferral has real holes:

- **HTTP and streamable-HTTP servers were not deferred** (#40314: the reporter measured 120K tokens
  loaded upfront anyway). Proxied servers likewise (#25894).
- **Discovery holes**: tools visible in `/mcp` but invisible to search (#57033, #38245).
- **First-turn unavailability breaks scheduled and headless runs** (#42148, #50312). This one matters
  directly for the launchd heartbeat work.
- **Subagents do not inherit tool search** (#23882).
- Deferral quietly extended beyond MCP to built-in system tools (#31002).

All are closed, but the lesson holds: **do not assume deferral, measure it.** The practical
consequence here is that the *remote* GitHub server is HTTP, which is exactly the class that failed to
defer. That makes the read-only + narrow-toolset configuration load-bearing rather than a nicety: it
is the only thing guaranteeing the footprint stays at 9.2k instead of 28.9k.

Per-server escape hatch worth knowing: `"alwaysLoad": true` in `.mcp.json` exempts a server from
deferral, for the case where an always-available tool matters more than the tokens.

## Two things that change the shape of this decision

**Cursor's ceiling is 40 tools total across all servers**, reported consistently across Cursor forum
threads (later reports of 80 exist but no vendor doc confirms either). Overflow does not error; the
agent silently loses access. Cursor has no tool-search equivalent. So the lean set is a Cursor
requirement, not a Claude Code one, which is what Session 8 was aimed at protecting in the first place.

**The MCP spec is mid-rewrite.** The 2026-07-28 RC removes the `initialize`/`initialized` handshake and
`Mcp-Session-Id`, moves protocol version and capabilities into `_meta`, deprecates Roots, Sampling and
Logging, and adds `server/discover`. That lands in roughly a week. It is an argument for wiring the
minimum viable set now and revisiting after the spec settles, rather than building out the full
activation matrix this week. (Note: `scripts/probe-mcp-footprint.mjs` speaks the current handshake and
will need updating.)

**Cloudflare shipped Code Mode**, which is the most interesting alternative in the space: instead of
exposing tool schemas it exposes two tools, `search()` and `execute()`, and the model writes TypeScript
against a typed SDK. Claimed reduction is 2,500+ API endpoints from >1.17M tokens to ~1,000. This is
the same idea as Anthropic's code-execution-with-MCP, and it is a better answer than either MCP or CLI
for very large API surfaces.

## Sources

- [Tool search, Claude Code docs](https://code.claude.com/docs/en/agent-sdk/tool-search)
- [Advanced tool use, Anthropic](https://www.anthropic.com/engineering/advanced-tool-use)
- [Code execution with MCP, Anthropic](https://www.anthropic.com/engineering/code-execution-with-mcp)
- [GitHub MCP server configuration](https://github.com/github/github-mcp-server/blob/main/docs/server-configuration.md)
- [MCP vs CLI token benchmark](https://onlycli.github.io/OnlyCLI/blog/mcp-token-cost-benchmark/)
