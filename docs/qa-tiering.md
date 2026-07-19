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
