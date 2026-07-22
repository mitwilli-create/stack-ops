# Spec: route council-pipeline internals and bulk toil to open-weight models

Status: ready-for-agent
Date: 2026-07-22
Sources: interview rulings (`~/Documents/handovers/routing-interview-answers-2026-07-22.md`),
adjudicated council (`~/.claude/agents/runs/dealbreaker-final-20260722-152400.md`),
verification pass (`research/gate-triage-audit-2026-07-22.md`).

## Problem Statement

Mitchell built a cheap open-weight routing tier and it works, and almost nothing
uses it. Across the decision log's entire lifetime, one real task has ever routed
to an open-weight model. Effectively all of his delegated work runs on frontier
models, which consumes his main-loop context on bulk toil and makes him wait.

Three specific causes, all measured rather than assumed:

1. The privacy gate refused 33% of his own benign public documentation, because
   private-path patterns were matched against prose. (FIXED this session.)
2. The council pipeline runs every internal stage on frontier models. Five
   open-weight slots are already wired in `career-ops/lib/council.mjs` and are
   used only as an optional adversary leaf, never for pipeline internals.
3. Routing was opt-in, and opt-in has already failed once.

## Solution

Move the council pipeline's internal stages onto already-wired open-weight slots,
close the three wiring gaps that make the evidenced routing table unroutable, and
make cheap routing the default path for bulk toil rather than an option.

An honest expectation, corrected during adjudication: **the 63x figure does not
generalize to a full council run.** The frontier fan-out is the cost centre and
Mitchell's own reservation list correctly keeps it there. The real prize is
roughly 1.3-1.7x on a full run and 20-80x on the internals slice. This spec is
worth building for the throughput and context reclaim, not for the headline
multiple.

## User Stories

1. As Mitchell, I want bulk toil routed to a cheap model without being asked, so that delegation happens by default instead of requiring me to remember it.
2. As Mitchell, I want every routing decision narrated inline as it happens, so that a silent handoff is visible as the drift signal it is.
3. As Mitchell, I want to write documentation that mentions the word "credentials" without the gate refusing it, so that ordinary prose work can route.
4. As Mitchell, I want a documentation reference to a credential file path to be distinguishable from a pasted credential file path, so that the gate blocks disclosure and not description.
5. As Mitchell, I want the credential scanner left untouched by every gate narrowing, so that the one control between a pasted key and a third party stays load-bearing.
6. As Mitchell, I want Google-proprietary material to remain blocked from every third-party provider until my confidentiality obligation lapses, so that a routing optimization never becomes a disclosure.
7. As Mitchell, I want confidentiality detection to run as deterministic rules before any model call, so that I am never asking a third party to remove material it should not have received.
8. As Mitchell, I want everything else in my corpus to route freely to Chinese-hosted providers, so that a settled risk decision is not re-litigated per task.
9. As Mitchell, I want claim extraction run by two independent cheap models whose outputs are compared, so that a silently dropped claim is caught rather than propagated.
10. As Mitchell, I want dedupe to be non-destructive with an explicit `uncertain` bucket, so that a false merge is recoverable instead of invisible.
11. As Mitchell, I want contradiction candidate-pair generation done cheap and the verdict rendered by a frontier model, so that both bodies of evidence about contradiction detection stay true.
12. As Mitchell, I want executive synthesis to stay frontier-only, so that the stage where judgment compounds is not the stage I economize on.
13. As Mitchell, I want fan-out dispatch, retry, archiving and indexing treated as code rather than model calls, so that I stop paying tokens for work that is not inference.
14. As Mitchell, I want verbatim model responses spliced into reports programmatically, so that formatting cannot silently alter what a model actually said.
15. As Mitchell, I want a cheap-model failure to escalate to a frontier model automatically, so that an overnight batch does not stall waiting for me.
16. As Mitchell, I want every escalation to print an unmissable banner and log a distinct outcome, so that escalation cannot quietly become the normal path.
17. As Mitchell, I want a privacy-gate refusal to never escalate, so that a security decision is never converted into a routing decision.
18. As Mitchell, I want provider selection sorted by throughput within the retention-filtered set, so that I stop paying a 12x latency penalty for an identical call.
19. As Mitchell, I want routed rows per week tracked in the decision log, so that adoption is measured rather than asserted.
20. As Mitchell, I want percent-of-delegatable-work-routed tracked, so that I can see the gap between what could route and what did.
21. As Mitchell, I want dollars-saved-versus-frontier tracked, so that the cost story is concrete even though it is the smaller half of the benefit.
22. As Mitchell, I want main-loop context consumed per session tracked, so that the benefit I actually feel is instrumented.
23. As Mitchell, I want recurring bulk jobs to run on a schedule overnight, so that volume moves off frontier without occupying my working session.
24. As Mitchell, I want email and transcript scanning routed cheap, so that high-volume mechanical reading stops consuming premium tokens.
25. As Mitchell, I want repo hygiene sweeps and memory dedupe routed cheap, so that zero-judgment work costs accordingly.
26. As Mitchell, I want outward prose in my voice kept on frontier models, so that I am not scrubbing hype out of cheap output.
27. As Mitchell, I want architecture and design decisions kept on frontier models, so that a 63x saving never buys me a confidently wrong call.
28. As Mitchell, I want anything touching a live external surface kept on frontier models, so that blast radius rather than capability sets that boundary.
29. As a future maintainer, I want each numeric routing threshold derived from a gold set rather than hardcoded, so that the pipeline is calibrated rather than guessed.
30. As a future maintainer, I want every gate change accompanied by a test that can go red, so that a green check proves something.
31. As a future maintainer, I want the known residual over-filter documented as an asserted test, so that nobody mistakes it for an undiscovered bug.
32. As a future maintainer, I want dispatch-table greps to cover the fallback-array helper, so that an audit does not under-report wired slots the way this one initially did.

## Implementation Decisions

**Already implemented and verified this session (stack-ops, uncommitted):**

- `privacy-gate.mjs` exports `extractPathLikeTokens()`. Private-path patterns now
  run against path-like tokens extracted from text, not the raw prose. Measured
  effect: public-doc refusals fell from 3 of 7 to 1 of 7 while the 34-case
  planted security corpus was unchanged at 22 caught, 12 passed, 0 leaks, 0 false
  blocks.
- Bare `credentials` removed from the private-path defaults; a file *named*
  credentials still matches.
- The infra signal now requires an action verb, so describing a secret-scan gate
  routes while performing one does not.
- `cheap.mjs` sends `provider: { data_collection: 'deny', zdr: true, sort: 'throughput' }`.
- `cheap.mjs` escalates to `CHEAP_ESCALATION_MODEL` (default
  `anthropic/claude-sonnet-5`) after all rungs fail, prints a boxed banner, logs
  `outcome: "escalated"` with `after_rungs`, and honors `CHEAP_NO_ESCALATE=1`.
  Escalation is scoped to rung failure; a gate refusal exits before the ladder is
  ever consulted, which was verified by planted input.

**Wiring gaps to close in `career-ops/lib/council.mjs`:**

- `openrouter:deepseek-v4` dispatches `deepseek-v4-pro` first with `-flash` as
  fallback. Every recommendation naming "deepseek-v4-flash" would get Pro today.
  Add a distinct flash-first slot for toil rungs rather than reordering the
  existing slot, so the capable tier stays reachable.
- No `gpt-oss-120b` slot exists. It is the best-evidenced extraction candidate
  and is currently unroutable. Wire it.
- `glm-4.7-flash` is not wired and no leg produced evidence for it. Do not wire
  it; shadow-only.
- `kimi` and `minimax-m3` are wired and were discussed by zero council legs. Do
  not assign them work on the council's silence alone; evaluate separately.

**Routing table (adjudicated):**

| Subtask | Verdict | Route to |
|---|---|---|
| Confidentiality detection | Non-LLM, pre-LLM, fail-closed | deterministic rules |
| Prompt prep | DLP pass, then cheap rewrite | `openrouter:qwen3-coder` |
| Fan-out dispatch and retry | Not an LLM task | dispatcher code |
| Claim extraction | Cheap with guardrails, two independent extractors | `deepseek-v4` flash-first slot + new `gpt-oss-120b` slot |
| Claim matching and dedupe | Cheap, non-destructive, pairwise, `uncertain` bucket | `openrouter:glm-5.2`, embedding pre-filter first |
| Contradiction candidate generation | Cheap | `openrouter:qwen3-coder` or `deepseek-v4` |
| Contradiction verdict | Frontier-only | frontier |
| Staleness | HTTP tooling + cheap time-sensitivity tag | code + `deepseek-v4` |
| Executive synthesis | Frontier-only | frontier |
| Formatting | Splice verbatim in code; cheap for the claim table only | code + `qwen3-coder` |
| Archiving and indexing | Not an LLM task | code + local embeddings |

**Adoption mechanism (ruled: both):**

- Interactive: the main loop shells out to `cheap --task <archetype>` by default
  on bulk toil and narrates the route inline. No new machinery.
- Scheduled: recurring jobs move to launchd overnight batches. Candidates named
  in the interview are log triage on health-probe output, hm-intel
  summarization, and repo hygiene sweeps.

**Measurement (ruled: all three, plus context).** Extend the decision log
consumer to report routed rows per week, percent of delegatable work routed,
dollars saved versus frontier equivalent, and main-loop context consumed per
session. Baseline to beat: 1 routed row, $0.0099 lifetime.

## Testing Decisions

A good test here asserts external behavior at the highest seam and can be made to
fail. This repo has already shipped two false "verified" results from checks that
could not see what they claimed to check, so the can-fail property is the bar.

- **Primary seam: the `cheap` CLI binary.** Every gate assertion runs planted
  input through the real binary and classifies the exit code, rather than
  re-implementing the gate. Prior art: the 34-case planted corpus used in this
  session's verification pass, and `--self-test` in the trufflehog pre-commit
  hook, which is the model to copy for any new gate.
- **Secondary seam: `classify()` with a built config.** Used only for cases where
  the CLI cannot express the input shape. Prior art: the existing 69 tests in
  `router.test.mjs`.
- **Council internals seam: the slot dispatch table.** Assert that a task
  requesting a flash rung actually receives flash, which is precisely the bug the
  deepseek-v4 ordering would cause today.
- Every gate change ships a test in both directions: one planted input that must
  be caught and one that must pass. Empty false cells from a corpus that could
  never populate them prove nothing.
- The known residual over-filter (a spelled-out private path inside prose still
  gates) is asserted as current behavior with a comment explaining why, so it
  reads as accepted rather than undiscovered.
- Do not test the numeric thresholds until they are derived from a gold set.
  Asserting a guessed threshold just freezes the guess.

## Out of Scope

- Routing Claude Code's main loop or Cursor's agent. Both are flat-rate surfaces;
  routing them converts flat spend into metered spend and is permanently barred.
- Wiring `glm-4.7-flash`. No evidence, not wired, shadow-only.
- Assigning work to `kimi` or `minimax-m3` on the strength of this council.
- Hardcoding any claim-count floor, Jaccard cutoff, coverage floor, audit rate or
  disagreement trigger. Six legs produced six different sets with zero
  calibration evidence.
- Entropy-based secret detection. Previously rejected; over-filters constantly on
  a substrate full of SHAs and UUIDs.
- Acting on Gemini's Question-2 practitioner material. Its citations are real
  papers with systematically shifted dates and mismatched numbers.
- Closing the residual path-in-prose over-filter. That needs a new ruling,
  because the only fix is to stop matching private paths in text entirely.

## Further Notes

- **Do not claim practitioners have reverted from cheap routing on these
  subtasks.** Five legs looked, including Grok with live X search, and found
  nothing. That is an evidence gap, not evidence of safety.
- **The interested-party signal inverted.** `glm-5.2`, an open-weight model, was
  more conservative about open-weight capability than the frontier legs, rated
  contradiction detection frontier-only, flagged its own recalled benchmarks as
  unverified, and produced the run's most accurate cost model ($0.30 estimated
  against $0.333 metered). Grok was the most open-weight-optimistic leg.
- **Claim extraction is the highest-risk rung.** A dropped claim is invisible to
  every downstream stage, because each stage stays internally consistent on an
  incomplete ledger. This is why extraction gets two independent extractors and
  why the guardrail is not optional.
- **Audit method note.** The original verification pass wrongly reported the
  council path as having zero open-weight rungs, because it grepped literal
  `model:` fields and the slots dispatch through an array-of-fallbacks helper.
  Grep the helper name too.
