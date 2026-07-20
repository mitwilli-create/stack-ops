# AGENTS.md: stack-ops

Single source of truth for any agent working in this repo (Codex, Claude Code, Cursor, Gemini CLI).
`CLAUDE.md` imports this file with `@AGENTS.md`, because Claude Code reads only that filename.

Read `~/Documents/claude-program-prompts/OPERATING-RULES.md` first. It carries the ruled quality/cost
tradeoffs, the privacy gate, the archive protocol, and the cross-cutting guardrails, and it supersedes
anything here that conflicts.

## What this repo is

Mitchell's model-routing and delegation substrate. It holds the `cheap` CLI and its privacy gate, the
openrouter-auto router, the PR-triage logic, the mem0 client, the council MCP server, and the anti-slop
prose gate. **It is intended to become public**, which shapes every constraint below.

## Hard constraints

- **`private/` is gitignored and must never be published.** It holds the decision log, the handover, the
  skills ledger, and pointers to where secrets live. `.gitignore` is a floor, not the gate: before ANY
  push, run a secret scan (gitleaks/trufflehog or a key-pattern grep) over the full tree AND git history,
  plus Mitchell's file-list review. See `private/HANDOVER.md`.
- **Never a secret VALUE anywhere in the tree.** Key names and vault paths only.
- **Never route a flat-rate surface.** Claude Code's main loop and Cursor's own agent (Composer, inline
  edit, autocomplete) are permanently out of scope: an active gateway credential replaces the subscription
  and bills per token. Cheap routing attaches to DELEGATED work only, via the `cheap` CLI.
  (`private/decisions/D6-claude-code-auth-and-routing.md`)
- **The privacy gate refuses rather than silently escalating.** Zero-data-retention is mandatory on the
  cheap path (`provider.data_collection: 'deny'`); a provider that cannot honour it receives no traffic.
  The credential scanner is load-bearing and scans full content, never sampled.
- **Test fixtures must be sanitized before they enter git history.** Real emails, addresses and client
  paths get replaced with example values *before* the commit, not after: afterwards it is a history
  rewrite, not an edit.
- **Route by the winning MODEL, never the brand and never the reputation.** "Open-weight equals cheap" is
  false at current prices. No self-favorable model comparison without a citation.

## Prose gate

Two mechanisms, one source of truth. Vale (`.vale.ini` + `styles/`) reads only `md`/`mdc`/`txt` and
silently drops some matches, so a byte-level grep in `scripts/` is the only cover for code and config.
Both fail the build; neither is warning-level. `private/**` is exempt: linting internal notes only trains
you to ignore the linter.

Em dashes are banned in outward materials. Vale's `existence` rule does not normalize smart quotes, so
generated token lists must flex U+0027 and U+2019.

## Verification

When you write a verification, first confirm the verification can fail. Two bugs in two sessions shipped
a false "verified" because the check could not see the thing it claimed to check (a unit test that built
a synthetic config instead of loading the real one; a probe that indexed an object as an array). A green
check that cannot go red is not a check.

Note the shell: `grep` here is ugrep, and bash and zsh differ on `$'\|'`. Re-typing a script's grep by
hand in a different shell invents gate bugs that do not exist. Verify by running the script against
planted bad input.

## Commands

| Task | Command |
|---|---|
| Tests | `npm test` |
| Prose gate | `vale --glob='!node_modules/**' .` then the grep sweep in `scripts/` |
| Cheap delegation | `cheap --task <archetype> --files … "instruction"` |

<!-- BEGIN STANDING-RULES (Mitchell global, installed 2026-07-18) -->
## Standing rules (global)

These apply to any agent working in this repo, including off-machine (CI, collaborators, cloud agents):

1. **Freshness re-anchor.** Before acting on the first input of a session, and again after any gap over ~3 hours, web-search to confirm the current Pacific date/time (PST/PDT-aware) and scan the task topic for anything that changed since your knowledge cutoff, before relying on training-data recall. Re-check any pending "today/tomorrow" commitment against the confirmed date.
2. **Stack-search before building.** At the start of any new build / feature / reusable tool, first research what already exists (X, Reddit, Hacker News, Discord, dev forums, package registries) for highly-rated, peer-recommended solutions. Report BUILD-vs-ADOPT with sources; bias to ADOPT over BUILD unless there is a real, audience-worthy gap. Build for an audience, not just yourself.
<!-- END STANDING-RULES -->
