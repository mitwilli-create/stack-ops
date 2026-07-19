# MCP capability layer

MCP servers are live tool/data bridges an agent (Claude Code, Cursor) calls
natively. The failure mode is **tool-spam**: too many active servers degrade the
agent's tool-selection. So the rule is a **tight foundational set everywhere** plus
**domain servers activated per-project**.

Repos + packages verified 2026-07-19 (`gh api` + npm).

## Foundational set (activate in every workspace)

| Server | Package / source | Use |
|---|---|---|
| GitHub | `@github/github-mcp-server` (or GitHub's remote MCP) | repos, PRs, issues, Actions |
| Playwright | `npx @playwright/mcp@latest` | browser automation / UI verification |
| Context7 | `@upstash/context7-mcp` | version-correct library docs on demand |
| Serena | `oraios/serena` (`uvx`/`npx @oraios/serena`) | semantic code retrieval + edit tools |
| Filesystem | `@modelcontextprotocol/server-filesystem` | scoped local file ops |
| Fetch | `@modelcontextprotocol/server-fetch` | URL → markdown |
| Sequential-Thinking | `@modelcontextprotocol/server-sequential-thinking` | structured multi-step reasoning |

## Domain set (activate per-project)

| Server | Package / source | Activate in |
|---|---|---|
| ElevenLabs | `elevenlabs-mcp` (pip) | voice-os, media |
| Cloudflare | `@cloudflare/mcp-server-cloudflare` | tunnel/Stream/dashboard ops |
| Notion | `makenotion/notion-mcp-server` | knowledge base |
| Firecrawl | `firecrawl-mcp` | scraping + JS-rendered pages |
| Apify | `apify-mcp-server` | 1000+ ready-made scrapers |
| Sentry | `@sentry/mcp-server` (remote `mcp.sentry.dev`) | monitoring |
| Google Workspace | Google's **official remote MCP** (OAuth; shipped ~June 2026) | Gmail/Drive/Calendar — do NOT build a custom Gmail wrapper |
| Exa | `exa-mcp-server` | agent web search |
| Obsidian | `MarkusPfundstein/mcp-obsidian` (needs the Obsidian Local REST API plugin) | the agent-queryable report store |

**Not a server:** mem0 integrates via its **SDK** (`mem0ai`) / cloud platform, not
a dedicated MCP — `mem0ai/mem0-mcp` is **archived**. **AssemblyAI** has no official
MCP → optional custom wrap (own-tool #5).

## Own-tool wraps (narrow MCP servers, per-project)

Wrap Mitchell's own tools so any agent can call them natively. Built narrow (few
tools each) and activated only in the projects that need them.

| # | Server | Wraps | Status |
|---|---|---|---|
| 1 | **council** | the multi-model council engine (`career-ops/lib/council.mjs`) | **BUILT** — `src/mcp/council-server.mjs` |
| 2 | career-ops orchestrator | the job-search pipeline (triage/queue/apply) | spec below |
| 3 | media pipeline | Veo / nano-banana / ElevenLabs / AssemblyAI / Descript per `MEDIA_ROUTER_MATRIX` | spec below |
| 4 | cloudflare-ops | tunnel + Stream + dashboard ops | spec below |
| 5 | AssemblyAI (optional) | transcription/diarization | optional |

Public server code carries **no private paths**: the engine location is a config
value (`COUNCIL_ENGINE_PATH`), set in the gitignored private config — the same
public-code / private-config split the router uses.

### #1 council (built)

`src/mcp/council-server.mjs` — a stdio MCP server exposing three narrow tools:

- `route_task` — given a task archetype, return the provider:model lineup the
  router picks (from `TASK_ROUTER_MATRIX`). Read-only, no spend.
- `route_media` — given a media task class, return the `MEDIA_ROUTER_MATRIX`
  policy entry (tool + model + key NAME + endpoint). Read-only, no spend.
- `list_council` — return the `RESEARCH_COUNCIL_LINEUPS` (debate lineups) + the
  dispatchable model ids. Read-only, no spend.

Running an actual paid council fan-out is deliberately **not** exposed as a
fire-and-forget MCP tool (it costs money + must pass the approval gate); the
server surfaces the routing *policy* so agents route correctly, and the paid run
stays behind the existing `run-council.mjs` + approval gate.

### #2-4 specs (next)

- **career-ops orchestrator** — tools: `triage_next`, `queue_status`,
  `apply_pack(company)`. Wraps the existing pipeline scripts; read-mostly, with
  side-effectful tools gated. Activate only in career-ops.
- **media pipeline** — tools: `generate_image`, `generate_video`, `tts`,
  `transcribe`. Dispatches per `MEDIA_ROUTER_MATRIX`; each tool names the provider
  + key it uses. Activate in voice-os / content-ops.
- **cloudflare-ops** — tools: `tunnel_status`, `stream_upload`, `purge_cache`.
  Wraps Cloudflare APIs; activate where hosting/tunnel work happens (this also
  provides the router's Cursor tunnel from `openrouter-auto.mjs`).

## Activation matrix (tool-spam discipline)

| Project | Foundational | + Domain | + Own-tools |
|---|---|---|---|
| career-ops | all 7 | Notion, Sentry, Google Workspace | council, career-ops orchestrator |
| voice-os / content-ops | all 7 | ElevenLabs, Firecrawl, Exa | council, media pipeline |
| stack-ops | all 7 | Exa, Obsidian | council |
| storytellermitch.com | Filesystem, Playwright, Fetch | Cloudflare | media pipeline, cloudflare-ops |

Keep the live set per project tight. If tool-selection quality drops, prune first.
