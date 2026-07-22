# Gate & triage verification, whole ecosystem, 2026-07-22

## Verdict

PASS-WITH-DEFECTS. Every gate filters correctly and every routing rung works
live, but the cheap tier is effectively unused: across the decision log's entire
lifetime only **one** real delegated task has ever routed to an open-weight
model. The machinery is sound. The adoption is near zero.

## Scope

Targets: 11 local repos + 22 GitHub repos (public and private), `~/.claude`
hooks, the `cheap` CLI, the council dispatch path.

Gates found: 6

| Gate | Entry point | Emits |
|---|---|---|
| Privacy gate (credential + PII + path + employer + infra) | `stack-ops/src/router/privacy-gate.mjs:244`, run via `cheap` | exit 3 + `cheap-decisions.jsonl` row |
| No-task refusal (anti frontier-fallthrough) | `stack-ops/src/router/cheap.mjs` | exit 8 + log row |
| Bulk-threshold advisory (2000 chars) | `cheap.mjs` `BULK_THRESHOLD_CHARS` | stderr note, non-blocking |
| trufflehog staged-diff secret scan | `<repo>/.git/hooks/pre-commit` | exit 1, blocks commit |
| relocation-os privacy marker scan | `relocation-os/scripts/privacy-check.sh` | exit 1, blocks commit |
| Prose/voice lint (em dash ban, hype) | `stack-ops/scripts/lint-prose.sh` | Vale errors |

Triage points found: 3

| Point | Entry point | Emits |
|---|---|---|
| Task-archetype ladder (6 archetypes, 2 rungs each) | `cheap.mjs` `LADDERS` | `requested` / `served` in decision log |
| PR reviewer triage | `stack-ops/src/router/pr-reviewer-triage.mjs` `triagePr()` | `{reviewers, mergeGate}` |
| Council model routing | `career-ops/lib/council.mjs`, `council-os/routing-tree.json` | per-model dispatch |

Unverifiable: council dispatch was not fired live (each call costs real money at
frontier rates and the question here is cost, not capability). Its model table
was read, not executed.

## Calibration (can-fail)

Every gate was observed going red on planted input.

- Privacy gate: 22 planted secrets/PII/infra strings, all refused (exit 3).
- trufflehog hook: ships a self-test; `PASS: staged secret blocks the commit` in
  6 of 6 repos that have it installed.
- relocation-os privacy scan: planted pattern file produced
  `PRIVACY FAIL: private pattern #1 ... found in tracked file(s)`; control
  pattern passed clean.
- Prose lint: fired 5 em dash errors.
- PR triage: docs typo lands CodeRabbit only, security+production lands
  CodeRabbit+Greptile+Qodo with a Qodo merge gate.
- Ladder: all 6 archetypes served by the expected model, live.

## Gate filtering, confusion matrix

**Privacy gate** (34 planted cases fed through the real `cheap` binary):

```
TP: 22   TN: 12   FN (under-filter): 0   FP (over-filter): 0
```

Caught: OpenAI/xAI/AWS/GitHub/Google/Slack keys, PEM blocks including a
lower-cased header, JWT, bearer header, `.env` style assignment, labelled
`client_secret`, Visa contiguous and grouped, Amex grouped, `ya29.` token,
SSN dashed and dotted, passport number, all 3 infra phrasings.

Passed correctly: benign code, salary and severance figures, home address and
phone and email, relocation and layoff status, a 40-char git SHA, a UUID, the
word "severance", an invoice number shaped like an SSN, the word "passport",
health information, prose rewrite, bulk summarize.

Zero leaks and zero false blocks on the synthetic corpus. The failure appears on
**real** content instead, see defect 3.

**trufflehog hook**: TP 1, TN 2, FN 0, FP 0 per repo across 6 repos (self-test
covers staged secret blocks, clean index survives, commit content intact,
untracked secret does not block).

## Speed

| Stage | Mean | p50 | p95 | Max | Budget | Result |
|---|---|---|---|---|---|---|
| Privacy gate decision (34 cases, includes node boot) | 53 ms | 42 ms | 98 ms | 169 ms | 250 ms (proposed) | PASS |
| Cheap-tier round trip, 15.6 KB payload | 3.7 s | 2.3 s | 12.8 s | 12.8 s | 30 s (proposed) | PASS |
| Cheap-tier round trip, 155 KB payload | 20.3 s | n/a | n/a | 20.3 s | 60 s (proposed) | PASS |

No budget was declared anywhere in the codebase, so the three above are proposed,
not found. The gate itself is negligible: essentially all of the 53 ms is Node
startup, the classification is pure and synchronous.

Tail note: `bulk_summarize` hit 12.8 s on DekaLLM while the identical payload to
the same model took 1.0 s on SambaNova and 3.4 s on DeepInfra. A 12x spread by
provider, not by model.

## Triage

**rapid: PASS.** Routing overhead is under 100 ms at p95. Upstream latency
dominates and stays inside the proposed budget at both payload sizes.

**regular: FAIL.** This is the headline.

Decision log lifetime (16 rows, 2026-07-20 to 2026-07-22):

- 4 successful calls, 12 refusals.
- Of the 4 successes, **1** was a real routed task to an open-weight model
  (`openai/gpt-oss-120b`, 17.6 KB, $0.00018).
- The other 3 were untagged `openrouter/auto` calls that landed on
  **frontier GPT-5.6** at $0.0034, $0.0061 and $0.0002. Those are misroutes: a
  "cheap" command served by a frontier model. They predate the exit-8
  no-task-or-model refusal, which now closes that hole (verified: an untagged
  call refuses).
- Of the 12 refusals, 11 are verification traffic (mine and a prior probe run),
  not real work.

Total lifetime cheap-path spend: **$0.0099**.

**Reconciliation note** (added 2026-07-22 after review flagged the two figure sets
as inconsistent). The $0.0099 / 4-successful-calls figures describe the LIFETIME
production log at `~/.claude/logs/cheap-decisions.jsonl`. The 7-of-7 / $0.00548
figures further down describe THIS AUDIT's live archetype probes, which were
written to a separate scratch log via `CHEAP_DECISION_LOG` precisely so
verification traffic would not contaminate the adoption baseline. The two sets are
disjoint by construction and are not meant to sum. Any figure quoted as "lifetime"
excludes probe traffic.

So: essentially 0% of delegated work is being routed. Effectively 100% of real
work is handled by the Claude Code main loop on the flat subscription. That is
not a dollar cost, it is a throughput and context cost: bulk toil that could run
in parallel on a $0.04/Mtok model is consuming the main loop's context window
instead.

**optimal: PASS on mechanism, untested at volume.** Every archetype landed on
the model its ladder specifies, live:

| Archetype | Requested | Served | Provider | Cost | Latency |
|---|---|---|---|---|---|
| bulk_summarize | openai/gpt-oss-120b | same | DekaLLM | $0.000134 | 12.8 s |
| log_triage | openai/gpt-oss-120b | same | SambaNova | $0.000660 | 1.0 s |
| structured_extraction | openai/gpt-oss-120b | same | DeepInfra | $0.000156 | 3.4 s |
| bulk_mechanical_edit | qwen/qwen3-coder-30b-a3b | same | SiliconFlow | $0.000254 | 2.3 s |
| boilerplate_generation | qwen/qwen3-coder-30b-a3b | same | Novita | $0.000254 | 1.3 s |
| long_context | deepseek/deepseek-v4-flash | same | Morph | $0.000501 | 1.7 s |
| long_context (155 KB) | deepseek/deepseek-v4-flash | same | Baidu | $0.003525 | 20.3 s |

7 of 7 succeeded, zero step-downs, zero timeouts. Chinese open-weight models are
serving and being served by Chinese providers (Qwen via SiliconFlow, DeepSeek via
Baidu). 57,540 tokens for $0.00548 total. The same token volume through Opus
would run roughly $0.35, a **63x** ratio.

All 5 ladder rungs verified live on the OpenRouter catalog with current prices.
One price comment is stale: `deepseek/deepseek-v4-flash` is annotated $0.04/$0.17
in `cheap.mjs:53` but actually prices at $0.098/$0.196.

**The council path has open-weight slots and never uses them.**

CORRECTED 2026-07-22. My original claim here was that the council path routes
100% frontier with no open-weight rung anywhere. That was WRONG. The council
agent challenged it and re-reading source confirms the challenge:
`career-ops/lib/council.mjs:1574-1617` wires five open-weight slots (`glm-5.2`,
`deepseek-v4`, `qwen3-coder`, `kimi`, `minimax-m3`), documented at line 36 as the
"open-weight toil tier". I missed them because my grep matched literal `model:`
fields and these dispatch through `_openRouterDispatch([...])` arrays instead.

The accurate finding: those slots are wired only as an OPTIONAL ADVERSARY LEAF
and are never used for pipeline internals. Claim extraction, cross-model claim
matching, dedupe, contradiction detection, staleness checks and formatting all
still run frontier on every council pass. The remedy is to USE the slots that
exist, which is a materially cheaper fix than adding them.

Method note for future audits: grepping for `model:` under-reports dispatch
tables that use an array-of-fallbacks helper. Grep the helper name too.

## Defects, ranked by blast radius

1. **No secret scan in career-ops, stack-ops, mission-control, home-ops.**
   career-ops has 7 hooks installed and none of them scans for secrets (its
   pre-commit is a warn-only branch-swap check). stack-ops is a **public** repo
   holding the router and a gitignored `private/` layer, with zero hooks
   installed. trufflehog is on the machine and the hardened hook already exists
   in 6 other repos. Fix: copy `content-ops/.git/hooks/pre-commit` into all four
   and run `--self-test` in each.

2. **Cheap tier is built and unused.** 1 real routed task ever. Fix: pick the
   three recurring bulk jobs (log triage on the career-ops health probe, bulk
   summarize across `hm-intel/`, mechanical edits across the worktree sprawl)
   and route them by default, then re-read the decision log in a week. The
   measurement to watch is routed-rows-per-week, not spend.

3. **Over-filter on real documentation.** 2 of 6 stack-ops public docs are
   refused by the privacy gate. `docs/mcp-layer.md` trips on the bare word
   "credentials" in prose; `docs/memory-mem0.md` trips on a documentation
   reference to `~/.secrets/api-keys.env`. Root cause: `privacy-gate.mjs:244`
   applies path patterns to body text as well as to the paths array. A 33%
   refusal rate on benign public docs is the reason bulk documentation work
   never routes. Fix: require a path-like context (a leading `/` or `~`, or a
   real entry in the paths array) before the private-path signal fires on text,
   and drop the bare word `credentials` from the default pattern.

4. **Two PR-triage tests cannot go red.** `router.test.mjs:238` claims "never
   assigns three reviewers" but passes `additions`/`deletions` where the function
   reads `linesChanged`, so the PR is scored as tiny and the small-PR guard drops
   Qodo. Feeding the documented shape, a security-labelled production PR **does**
   get three reviewers plus a Qodo merge gate. The test asserts a property the
   code does not have and passes anyway. Fix: correct the input keys and decide
   which behavior is intended.

5. **`lint-prose.sh` silently ignores its file argument.** Passing a specific
   file scans the whole repo instead. Anyone linting one document before shipping
   it gets a repo-wide result and no signal about their file. Fix: honor argv, or
   fail loudly when given an argument it will not use.

6. **`council-os/routing-tree.json` is 2 months stale** (generated 2026-05-18)
   and its slots name retired models: `claude-opus-4-7`, `gpt-5-5-pro`,
   `gemini-3-1-pro`. Its own build script says regenerate if older than 30 days.
   Fix: `node council-os/scripts/build-routing-tree.mjs` after refreshing
   `routing-rules.md` to current model IDs.

7. **Provider latency spread of 12x within one model.** DekaLLM served
   `gpt-oss-120b` in 12.8 s where SambaNova served the identical payload in 1.0 s.
   Fix: add a provider `sort: "throughput"` preference alongside the existing
   `data_collection: "deny"`, which keeps ZDR intact while avoiding the slow tail.

8. **Stale cross-repo claim.** `cheap.mjs:46` says the ladders mirror
   "career-ops TASK_ROUTING_LADDERS". No such symbol exists in career-ops. Fix:
   delete the reference or restore the source of truth.

## Assumptions made

- No latency budget is declared anywhere, so the three budgets in the Speed table
  are proposed by this audit.
- Council dispatch was read, not executed, because firing it costs real money at
  frontier rates and its cost profile is the finding, not its correctness.
- The 22 GitHub repos were enumerated for visibility and push date; only the 11
  with local checkouts were gate-tested. The 11 unchecked remotes are dormant
  (last push 2026-03 or earlier) except `claude-wrap-recap-skills`.
- All planted inputs are synthetic. No real key or real person's data was used,
  and nothing was committed.
