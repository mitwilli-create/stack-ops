# SPEC: Kimi integration into stack-ops

**Status:** DRAFT, awaiting Mitchell's review
**Date:** 2026-07-22
**Inputs:** [council report](../../../.claude/agents/runs/council-report-20260722-133000.md) (6 legs, 5 responded, $1.93) → [dealbreaker adjudication](../../../.claude/agents/runs/dealbreaker-final-20260722-133117.md) (18 claims, 14 primary-source verifications)
**Supersedes:** nothing. This is the first ruling on Moonshot models in this repo.

---

## 1. Verdict

**Do not migrate any Kimi model into the stack.** All nine evaluated components are REJECT.

This spec was commissioned as a migration plan. The research it rests on inverted the premise, so what follows is a decision record with an explicit re-evaluation trigger, plus the two real defects the research surfaced along the way. Both defects are independent of Kimi and both are worth shipping.

The one-line reason: **Kimi's cheapest relevant model is 7-18x the input price of the ladder rung it would replace, and the newest one is 31-81x and slower.** No quality argument closes a gap that size on bulk summarization, log triage or mechanical editing.

## 2. What was evaluated

| # | Component | Verdict | Convergence |
|---|---|---|---|
| A | `cheap` CLI ladder rungs | REJECT | 5/5 |
| B | Privacy gate / ZDR path | REJECT | 5/5 |
| C | `openrouter/auto` router | REJECT | 5/5 |
| D | PR triage | REJECT | 5/5 |
| E | mem0 client | REJECT | 5/5 |
| F | Council MCP fan-out leg | REJECT | 3/5, reasoning replaced |
| G | Anti-slop prose gate | REJECT | 5/5 |
| H | career-ops scripts | REJECT | 5/5 |
| I | Routine LLM deployment/triage | REJECT | 5/5 |

Components A-E and G-I are rejected on arithmetic that four independent legs reproduced and the dealbreaker re-derived against OpenRouter's live catalog API. Component F is the only one where a model argued for adoption; see §4.

## 3. The arithmetic (primary-source verified 2026-07-22)

| Model | Input $/Mtok | Output $/Mtok | Context | Endpoints |
|---|---|---|---|---|
| Kimi K3 | 3.00 | 15.00 | 1,048,576 | **1** (Moonshot AI only) |
| Kimi K2.7 Code | 0.82 | 3.75 | 262,144 | 14 |
| Kimi K2.6 | 0.684 | 3.42 | 262,144 | 21 |
| *current ladder* | | | | |
| `openai/gpt-oss-120b` | 0.037 | 0.170 | | |
| `deepseek/deepseek-v4-flash` | 0.098 | 0.196 | 1,048,576 | |
| `qwen/qwen3-coder-30b-a3b-instruct` | 0.070 | 0.270 | | |
| `z-ai/glm-4.7-flash` | 0.061 | 0.400 | | |

Four disqualifying facts, each independently verified:

1. **Price.** K3 is a 31-81x input premium over the ladder. K2.6, the cheapest serious candidate, is still 7-18x.
2. **Speed.** K3 measures 4.70s TTFT / 34.2 tok/sec against sub-second and 100+ tok/sec flash incumbents. Always-on reasoning bills and delays every mechanical request. It loses on **both** halves of the brief, cost and latency.
3. **The 1M context buys nothing new.** `deepseek/deepseek-v4-flash` already provides 1,048,576 context at $0.098 input, and is ZDR-eligible. Unanimous across all five legs.
4. **The weights are not out.** K3 was announced 2026-07-16; weights are dated 2026-07-27. The "open-weight adversary" argument today describes a model nobody can self-host, single-homed on one provider with no failover.

**ZDR is not a reason.** The council's headline rationale was that Kimi endpoints are not zero-data-retention capable. That is false and was cut. `GET /api/v1/models?zdr=true` returns 222 of 342 models and every Kimi slug except the `~kimi-latest` alias is in the filtered set; K3 has exactly one endpoint, so that endpoint is necessarily ZDR-eligible. The rejection stands on economics, not privacy. Recording this so the reason does not get relitigated on a premise that was already falsified.

## 4. Component F, the only live question, and why it still fails

One leg (Gemini) said ADOPT, claiming ~$240/month saved by swapping Kimi into the council fan-out. One leg (Grok multi-agent) said PILOT at ~$5.40/month. Both were cut.

Both computed savings against displacing "a frontier chain-of-thought leg at ~$15/$75." **That leg does not exist in this council.** Measured per-leg cost for the run that produced this spec:

| Leg | Cost | Share |
|---|---|---|
| `xai:grok-4-20-multi-agent` | $1.678 | **87%** |
| `google:gemini-3.1-pro` | $0.103 | 5% |
| `perplexity:sonar-reasoning-pro` | $0.071 | 4% |
| `openai:gpt-5.6-sol` | $0.067 | 3% |
| `xai:grok-4-x-search` | $0.015 | 1% |

The Anthropic slot is stale-404 and was omitted entirely. Displacing a $0.067 leg with a $3/$15 model saves nothing. The only leg worth displacing on cost is grok-4-20-multi-agent, whose realized blended rate is **$4.00/Mtok** ($1.678 / 419,482 tokens). K3, billing its always-on thinking as $15/Mtok output on a workload that is overwhelmingly generated tokens, lands at or above that. **The saving is bounded near zero and may be negative.**

## 5. Re-evaluation trigger

Reopen this decision when **all four** hold, not before:

1. K3 weights have actually shipped (expected 2026-07-27).
2. A second OpenRouter provider serves K3, so the leg has failover.
3. The thinking-history replay question is settled. Check whether `platform.kimi.ai/docs/guide/kimi-k3-quickstart` requires echoing `reasoning_content` across chained calls. If it does, cost inflates further and this stays closed.
4. Someone runs the A/B: `moonshotai/kimi-k3` against `xai:grok-4-20-multi-agent` on an identical council prompt, comparing **realized** cost and synthesis quality.

Until then, no Kimi slug enters `LADDERS`, the council lineup, or any archetype.

## 6. Changes this spec DOES authorize

Two defects the research surfaced. Neither has anything to do with Kimi; both are live.

### 6.1 Privacy gate asserts a stronger guarantee than the flag it sends

**Severity: real gap in a security boundary. Confidence: High, primary docs.**

`src/router/cheap.mjs:182` currently sends:

```js
        provider: { data_collection: 'deny' },
```

OpenRouter documents `data_collection` ("control whether to use providers that may store data") and `zdr` ("restrict routing to only ZDR endpoints") as **two distinct fields**. Neither is documented as subsuming the other, and the ZDR-filtered catalog is strictly smaller (222 vs 342). A provider can decline to train on prompts while still holding them transiently for abuse monitoring. AGENTS.md makes ZDR mandatory on this path, so the gate is currently claiming more than it buys.

**Change:** send both.

```js
        provider: { data_collection: 'deny', zdr: true },
```

Update the comment block above it to record that the two fields are separate controls, cite `https://openrouter.ai/docs/features/provider-routing`, and date the verification.

**Blast radius: zero.** All five distinct ladder rungs (`openai/gpt-oss-120b`, `deepseek/deepseek-v4-flash`, `qwen/qwen3-coder-30b-a3b-instruct`, `z-ai/glm-4.7-flash`, `qwen/qwen3-coder`) pass `zdr=true`. Nothing narrows in practice.

**Verification, per AGENTS.md. Confirm the check can go red before trusting it:**

```bash
# Must print zdr strictly less than all. Equal means the filter is a no-op.
curl -s https://openrouter.ai/api/v1/models | jq '.data | length'
curl -s 'https://openrouter.ai/api/v1/models?zdr=true' | jq '.data | length'
```

Then plant a bad input: temporarily point a rung at `qwen/qwen3-coder-plus` (confirmed in-catalog, confirmed absent from the ZDR set) and confirm the call is **refused**, not silently routed. A pass there means the flag is not being honored.

### 6.2 Ladder price comments are stale and understate spend

**Severity: cost models built on these are wrong by up to 48%. Confidence: High, primary-source.**

`src/router/cheap.mjs:50-56` annotates each ladder with one price pair, but each ladder holds **two** models. The annotation describes the first rung and was silently attributed to the fallback.

| Slug | Comment implies | Actual in/out |
|---|---|---|
| `openai/gpt-oss-120b` | $0.04 / $0.17 | $0.037 / $0.170, accurate |
| `deepseek/deepseek-v4-flash` | $0.04 / $0.17 | **$0.098 / $0.196** |
| `qwen/qwen3-coder-30b-a3b-instruct` | $0.07 / $0.27 | $0.070 / $0.270, accurate |
| `z-ai/glm-4.7-flash` | $0.07 / $0.27 | **$0.061 / $0.400** |

`glm-4.7-flash` output is 48% more expensive than annotated, and it is the fallback on both `bulk_mechanical_edit` and `long_context`, the rungs carrying the largest payloads. Every step-down understates spend.

**Change:** annotate per-model rather than per-ladder, so a fallback's price is visible at the point of fallback. Carry a `verified: 2026-07-22` date on the block. The existing "re-check before trusting them, they move" warning was correct and was not followed; make the notation shape make the drift visible instead.

### 6.3 career-ops (no change here, pointer only)

All five legs independently concluded the career-ops overage was a **scheduling** problem, not a model-choice problem, roughly 40 scripts on ~100 timers with vendor auto-reload on. This matches the project's own record. No Kimi migration addresses it, and no model swap will. The remedy is a control plane: central scheduler and queue, per-workload token and dollar caps, idempotency keys, change detection, concurrency limits, retry budgets, batching, dry-run cost estimation, and a global circuit breaker. Out of scope for this spec; flagged so it does not get miscoded as a routing problem.

## 7. Out of scope

- Any change to flat-rate surfaces. Claude Code's main loop and Cursor's agent remain permanently unroutable.
- The council MCP lineup composition. Component F is REJECT; the grok-4-20-multi-agent cost concentration (87% of spend) is a real and separate question this spec does not answer.
- The career-ops control plane (§6.3).

## 8. Open risk carried forward

**K3 thinking-history replay: UNDECIDABLE.** Three legs assert K3 degrades sharply unless the full prior reasoning block is resent across chained calls; one leg marked it unverified; no primary source authenticated it. It does not change the verdict, since component F already fails on economics. It becomes load-bearing only if the §5 trigger fires.

**Single-sourced practitioner claims.** The `perplexity:sonar-deep-research` leg failed at 301s. It was the citation-harvest leg. Every practitioner-anecdote claim in the source research (tool-schema regressions, structured-JSON failure rates, 429 capacity crunch) is single-sourced and unverified. No price, slug, context-window or ZDR conclusion is weakened; those were verified against the catalog API directly.
