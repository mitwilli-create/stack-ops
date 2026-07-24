---
name: github-readiness
description: Audit Mitchell's GitHub presence against current hiring-manager and recruiter signals, from any CLI, by driving the shared council MCP server. Use when the user asks to "audit my GitHub for hiring", "align GitHub to recruiter signals", "github readiness check", or "what should my GitHub look like for [role]". Cross-CLI (Codex, Gemini CLI, Grok, Kimi) via the council MCP server.
---

# GitHub Readiness (cross-CLI)

This is a thin orchestrator over the shared council engine. In Claude Code the full
`github-readiness` agent runs the flow; from other CLIs you run the same flow by
calling the **council MCP server** tools directly.

## Flow

1. **Inventory** - read Mitchell's career corpus (`~/Documents/career-ops`: `cv.md`,
   `config/profile.yml`, `modes/_profile.md`) and snapshot his live GitHub. Two
   separate fetches: (a) the repository inventory + metadata via
   `gh repo list mitwilli-create --limit 100` (include private), and (b) the
   profile README on its own, which lives in the special
   `mitwilli-create/mitwilli-create` repo, e.g.
   `gh api repos/mitwilli-create/mitwilli-create/readme -H "Accept: application/vnd.github.raw"`.
   `gh repo list` returns repo metadata only, never the profile README, so fetch
   the README explicitly.
2. **Research the signals** - call `run_researcher("Current GitHub hiring-manager
   and recruiter signals for <target roles: FDE, AI Solutions Architect, AI
   Enablement, DevRel, Comms Lead> in 2026: what pinned repos, READMEs, commit
   cadence, and profile copy actually move a hiring decision")`. For a broader
   cross-model debate pass `lineup: "research5"` (preview cost first with
   `COUNCIL_DRY_RUN=1`).
3. **Adjudicate** - pass the researcher's report to `run_dealbreaker(report)` to
   keep only verified/corroborated signals and cut unsupported ones.
4. **Gap analysis** - tie each adjudicated signal back to the corpus + live GitHub
   snapshot and produce a prioritized action plan.

## Tools used (council MCP server)

- `run_researcher(question, lineup?)`
- `run_dealbreaker(report, lineup?)`
- `run_council(question, lineup?)` (optional, when a specific claim needs breadth)

All three are cost-gated: `COUNCIL_DRY_RUN=1` previews, `COUNCIL_MAX_CALL_USD`
(default `$5`) caps per call, `MONTHLY_BUDGET_USD` bounds the month. Preview any
broad lineup before running it live.

Never invent unstated facts about a named person; omit or ask. Scrub em dashes from
any outward-facing copy you draft.
