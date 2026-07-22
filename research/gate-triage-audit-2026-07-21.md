# Gate & triage verification, stack-ops routing substrate, 2026-07-21

## Verdict
**PASS-WITH-DEFECTS.** The gate and triage logic are *correct*, proven by planted
input against the real `cli.mjs` / `cheap.mjs` (0 under-filters, 0 over-filters, leak
guards fire). The defect is **adoption, not correctness**: the substrate is barely used
(16 log lines, mostly probes), so the Anthropic/Perplexity overages came from ~40
career-ops scripts calling frontier APIs *directly*, bypassing this proven-cheap path.
Fixing the overage = routing that traffic THROUGH this substrate + adding a research rung.

## Scope
Target: `~/Documents/stack-ops/src/router/` (private overlay `private/router-config.mjs` present → real effective gate exercised, not the synthetic-config trap)
Gates found: 4, (1) privacy-gate credential/PII/path/employer/infra scanner (`cli.mjs`); (2) cheap-CLI privacy refusal; (3) cheap-CLI untagged-leak refusal; (4) prose gate (Vale+grep, out of routing scope, not re-tested here)
Triage points found: 3, (a) route AUTO vs ANTHROPIC_DIRECT (`privacy-gate.classify`); (b) archetype→model ladder (`cheap.mjs LADDERS`); (c) `resolveTarget` route→provider/model (`openrouter-auto.mjs`)
Unverifiable: prose gate (declared out of scope for this overage audit)

## Calibration (can-fail)
Yes, every gate observed going red on planted input. Secrets/PII/paths → `anthropic-direct`; benign → `auto`. The contrast proves discrimination, not a stuck check. Live PostToolUse hook independently confirmed "privacy gate REFUSED · secret-or-key" on the planted key.

## Gate filtering, confusion matrix
privacy-gate   TP: 15  TN: 7  FN(under-filter): 0  FP(over-filter): 0
  under-filters (leaks): none, all 15 (openai/xai/aws/github/google/pem/bearer/jwt/env-style/card-contiguous/card-grouped/ssn/passport/infra-rotate/private-path) → direct
  over-filters (false blocks): none, all 7 ruled-ALLOW cases (bulk-summarize, mechanical-edit, salary, layoff, health, "password" word w/o value, home city) → auto
  boundary: empty + whitespace → direct (deny-by-default) ✓

cheap-CLI gates   all correct:
  untagged call (no --task/--model) → exit 8 REFUSED (the leak guard from commit 8bb9ce5) ✓
  bad task name → exit 8 REFUSED ✓
  tagged + planted secret → exit 3 REFUSED (privacy gate in front of the cheap path) ✓
  tagged bulk_summarize → route auto, model openai/gpt-oss-120b ✓
  explicit --model → honored, stands alone ✓
  ZDR: `provider: { data_collection: 'deny' }` present in the POST body (cheap.mjs:182) ✓

## Speed (tight)
privacy-gate: ~45ms per real invocation incl. Node cold-start; pure-regex, no network. No budget declared in-repo → propose <100ms/decision. **PASS.**

## Triage
rapid:   PASS, 45ms/decision, far under budget; cheap.mjs has a 180s upstream timeout so a stuck Auto pick can't hang the caller.
regular: **FAIL (adoption)**, decision log = 16 lines total, 4 ok / 12 refused, no sustained real traffic. Delegated career-ops work that SHOULD route here does NOT (it hits frontier APIs directly). The 3 historical `served: openai/gpt-5.6-sol` rows are the pre-fix untagged→frontier leak fingerprint; the untagged-refusal now closes that specific hole, but real bulk work still isn't being sent through the CLI at all.
optimal: PARTIAL, for the task classes it covers, routing is correct (bulk/mechanical/log/extraction → cheap OpenRouter models). BUT the ladder has **no research/QA archetype**, so research-class work (career-ops council/intel on Perplexity `sonar-deep-research`) has no cheap rung.

> **CORRECTED 2026-07-22.** This originally read "defaults to the most expensive
> frontier path". That is wrong for this CLI: `cheap.mjs` REFUSES an untagged call
> outright (exit 8, added after this audit was written), so nothing silently
> downgrades to frontier here. Callers OUTSIDE the CLI (career-ops council and
> intel hitting Perplexity `sonar-deep-research` directly) do still route to
> frontier providers, and that is where the Perplexity overage actually comes
> from. Defect 1 below already names that as the real cause.

## Defects, ranked by blast radius (= overage-reduction impact)
1. **[HIGHEST] Substrate not wired into career-ops.** ~40 scripts call `api.anthropic.com` (Opus) and Perplexity `sonar-deep-research` directly, bypassing the proven-cheap gate+ladder. This is the entire overage. Fix: route delegated LLM work through `cheap --task …`; keep only genuinely deep/sensitive work on the frontier path. (Execute via `~/career-ops-cost-optimization-prompt.md`.)
2. **No cheap research rung.** Add a `research` archetype so research work downshifts from `sonar-deep-research` to `sonar`/`sonar-reasoning` (or a cheap OpenRouter model) unless deep research is truly required. Without it, every research call is frontier-priced.
3. **Ladder prices self-declared, unverified since 2026-07-19** (code says "re-check, they move"). Re-verify against the live OpenRouter catalog before trusting the $/Mtok figures that justify each rung.
4. **Roster only partially leveraged by the CLI.** cheap.mjs uses OpenRouter's cheap generation models only; Perplexity/Gemini/Grok/media tiers are leveraged on OTHER surfaces (council MCP), not here, correct by design, but means "route everything cheap" requires BOTH surfaces to be adopted, not just this CLI.

## Assumptions made
- Prose gate excluded (not a spend/routing control; user's focus is overage).
- No in-repo latency budget → proposed <100ms/decision.
- cheap.mjs stdin must be closed (`</dev/null`) to test non-interactively; the earlier 2-min hang was a test-harness stdin issue, not a routing bug.
