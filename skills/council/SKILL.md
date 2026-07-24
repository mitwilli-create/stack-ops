---
name: council
description: Run a multi-model council, a research-framed fan-out, or a report adjudication from any CLI by calling the council MCP server's execution tools. Use when the user asks to "ask the council", "consult the models", "research X across models", "run the researcher", or "run the dealbreaker / adjudicate this report". Works in Codex, Gemini CLI, Grok, and Kimi via the shared council MCP server.
---

# Council (cross-CLI)

Mitchell's council/researcher/dealbreaker pipeline runs on ONE shared engine
(`career-ops/lib/council.mjs`). Every CLI reaches it the same way: by calling the
execution tools on the **council MCP server** (`src/mcp/council-server.mjs` in
`stack-ops`). You do NOT reimplement anything - you call a tool.

## Tools (on the `council` MCP server)

- `run_council(question, lineup?)` - fan `question` out to a lineup and return
  every model's response. `lineup` is optional: an array of `provider:model` ids,
  a named lineup (`"default"` | `"fanout"` | `"research5"`), or one id. Omit it for
  the cheapest single-model default.
- `run_researcher(question, lineup?)` - same, but framed for rigorous, cited
  research and a synthesized bottom line. Omit `lineup` for the cheap default; pass
  `"fanout"` or `"research5"` for a broader debate.
- `run_dealbreaker(report, lineup?)` - send a research report (inline text OR a
  path to a report file) for claim-by-claim adjudication: keep verified /
  corroborated claims, cut unsupported / contradicted ones, return a cleaned
  report plus an audit list.

## How to use

1. Pick the tool that matches the ask (council = breadth, researcher = cited
   synthesis, dealbreaker = adjudicate an existing report).
2. Call it with the question (and a `lineup` only if breadth is explicitly wanted).
3. Present the returned results; for `run_dealbreaker`, present the cleaned report
   and the audit list.

## Cost + safety (already enforced by the server)

Execution tools spend real money, so the server gates every call:
- `COUNCIL_DRY_RUN=1` → the tool echoes the planned lineup and a cost estimate and
  dispatches nothing. Use this to preview an expensive lineup first.
- `COUNCIL_MAX_CALL_USD` (default `$5`) → a per-call hard cap; the tool refuses if
  the estimate exceeds it.
- `MONTHLY_BUDGET_USD` → the tool refuses if a single call alone would exceed it,
  and the engine's own per-vendor monthly cap still applies.

When in doubt about spend, run once with `COUNCIL_DRY_RUN=1`, read the estimate,
then run for real.
