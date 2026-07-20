# QA tiering

Two orthogonal QA layers: **code** (review bots) and **content** (detectors + a
voice linter). Both operate as tiers, never as "one bot on everything" or "AI found
no issues = ship."

## Code QA (decision G)

| Tier | Tool | When |
|---|---|---|
| Default (every repo) | **CodeRabbit** | always-on, diff-only, lowest noise |
| Complex / critical repos | **+ Greptile** | full-codebase semantic index; higher catch, higher false-positive load |
| Production-critical repos | **+ Qodo (merge-gate)** | only on genuinely high-stakes PRs (critical paths, risk labels, releases/migrations) |

Routing is automated by `src/router/pr-reviewer-triage.mjs` (built on the router
substrate): it returns the reviewer set for a PR from diff size, files touched,
risk labels, and repo tier. **Anti-patterns it enforces:** never three bots on a
small low-risk PR; never let "AI found no issues" be the only required check (CI +
a human still gate). career-ops already runs CodeRabbit + Greptile + Qodo; the
triage decides which fire per PR.

### Provisioning status (2026-07-19)

- **CodeRabbit** — live, always-on. The only **repo-file** config (`.coderabbit.yaml`).
- **Greptile** — signed up (complex-repo tier). Activated per-repo via its **GitHub App + dashboard**; no repo file.
- **Qodo** — unblocked (production-critical merge-gate). Activated via its **GitHub App**, and enforced as a **required status check in branch protection**; no repo file (career-ops runs it dashboard-configured).

So only CodeRabbit is scaffolded in-repo. Turning on Greptile / Qodo for a repo is a GitHub-side step (install the App + add the required check) — Mitchell's action.

### Per-repo tier assignment (2026-07-19)

Criticality read from the environment (live launchd pipelines, public URLs, repo purpose), not asked.

| Repo | Signal | Tier | Bots |
|---|---|---|---|
| career-ops | dozens of live launchd pipelines + dashboard | Production-critical | CodeRabbit + Qodo (already wired; triage adds Greptile per-PR) |
| storytellermitch-site | live public site (storytellermitch.com) | Production-critical | CodeRabbit + Qodo merge-gate |
| voice-os | golden-file determinism, LangGraph pipeline | Complex | CodeRabbit + Greptile |
| stack-ops | routing substrate, multi-module + tests | Complex | CodeRabbit + Greptile |
| broll-pipeline | media pipeline | Complex | CodeRabbit + Greptile |
| council-os | KB the agents read | Complex | CodeRabbit + Greptile |
| relocation-os | personal planning | Standard | CodeRabbit only |
| content-ops | content | Standard | CodeRabbit only |
| mission-control | small utility | Standard | CodeRabbit only |
| monolith | dormant feature branch | Standard | CodeRabbit only (add when reactivated) |
| mesa | deferred (not adopted) | — | skip until the mem0 head-to-head |

**Never three bots on one PR:** where a repo qualifies for two tiers (career-ops is both prod-critical and complex), `src/router/pr-reviewer-triage.mjs` picks the subset per PR by diff size / risk labels. `.coderabbit.yaml` was scaffolded into every repo that lacked one on 2026-07-19 (adapted from career-ops's churn-tuned baseline: `chill` profile, pinned correctness/security/data-integrity, process-boilerplate suppressed, `code_guidelines` off, `learnings` local). career-ops + relocation-os kept their existing configs; monolith (dormant) was skipped. The remaining work is the GitHub-side Greptile/Qodo activation per the tier table above.

## Content QA (decision G)

**Keep:** Pangram (AI-detection — the one detector worth paying for; its low-FPR
result is independently verified) + Originality (plagiarism, wired as a
**REGULAR-firing** gate, not ad hoc). **Drop:** GPTZero + Sapling (redundant with
Pangram; formally retire the keys in the secrets-file pass).

Detection is **triage, not truth**: one paid detector + provenance logging + a
private quarterly benchmark + a human editorial pass. **Never accuse on a detector's
output alone.**

## Voice linting: Vale → Voice OS

`vale` validates prose against Mitchell's actual voice, not generic style. Config at
`.vale.ini` + `styles/VoiceOS/`:

- **EmDash** (error) — em/en dashes are banned in outward materials; the linter
  fails on sight so the rule is enforced structurally, not by memory.
- **AntiSlop** (warning) — flags hype/slop vocabulary and the banned word "kill";
  the anti-slop *process* (draft → cut 60-80% → rewrite in voice with concrete
  facts → grep out hype) is what the warning nudges toward.

Wire it into CI as a non-blocking check first (warnings), promote EmDash to a
blocking gate on outward-facing docs. For the full corpus-measured voice pipeline
(six-axis calibration, live QA gate) use the Voice OS system itself; Vale is the
fast always-on pre-filter that catches the two hardest rules cheaply.

```bash
brew install vale
vale docs/            # lint the public docs
```
