---
name: linkedin-readiness
description: Audit Mitchell's LinkedIn profile against current hiring-manager and recruiter signals, from any CLI, by driving the shared council MCP server. Use when the user asks to "audit my LinkedIn for hiring", "linkedin readiness check", "align my LinkedIn to recruiter signals for [role]", or "refresh my LinkedIn strategy". Cross-CLI (Codex, Gemini CLI, Grok, Kimi) via the council MCP server.
---

# LinkedIn Readiness (cross-CLI)

A thin orchestrator over the shared council engine. In Claude Code the full
`linkedin-readiness` agent runs the flow; from other CLIs you run the same flow by
calling the **council MCP server** tools directly.

## Flow

1. **Inventory** - read Mitchell's career corpus (`~/Documents/career-ops`:
   `cv.md`, `config/profile.yml`, `modes/_profile.md`, any `data/linkedin-*`
   files) and assemble the most current available snapshot of
   `linkedin.com/in/mitwilli`.
2. **Research the signals** - call `run_researcher("Current LinkedIn
   hiring-manager and recruiter signals in 2026 for <target roles: FDE, AI
   Solutions Architect, AI Enablement, DevRel, Comms Lead>: what headline, About
   section, featured items, activity cadence, and skills actually move a recruiter
   or hiring manager")`. Grok's live-X access is especially useful here - pass
   `lineup: "research5"` (which includes a live-search lane) for the broad debate,
   after previewing cost with `COUNCIL_DRY_RUN=1`.
3. **Adjudicate** - pass the researcher's report to `run_dealbreaker(report)` to
   keep only verified/corroborated signals.
4. **Gap analysis** - tie each adjudicated signal back to Mitchell's current
   profile state and produce a prioritized, copy-paste-ready action plan.

## Tools used (council MCP server)

- `run_researcher(question, lineup?)`
- `run_dealbreaker(report, lineup?)`
- `run_council(question, lineup?)` (optional, when a specific claim needs breadth)

All three are cost-gated: `COUNCIL_DRY_RUN=1` previews, `COUNCIL_MAX_CALL_USD`
(default `$5`) caps per call, `MONTHLY_BUDGET_USD` bounds the month.

Never invent unstated facts about a named person; omit or ask. Scrub em dashes from
any outward-facing copy you draft.
