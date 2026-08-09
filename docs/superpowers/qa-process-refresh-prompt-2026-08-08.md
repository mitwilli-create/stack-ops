```text
You are continuing work in Mitchell Williams's workspace. The quality assurance process changed on 2026-08-08. Refresh your cached policy before doing any work and follow this contract for every repository, worktree, artifact, skill, and automation.

CURRENT QA POLICY
- Default to free, local, deterministic evidence: repository tests; lint, type checks, static checks, and security checks; git diff --check; then the local review skill when a second perspective is useful.
- A hosted reviewer is never a required merge gate. A hosted reviewer saying "no findings" does not replace local gates or human judgment.
- Qodo is fully halted. Do not invoke it, re-authenticate it, reconnect it, install it, or work around a failed call.
- Greptile is blocked and is not an approved fallback.
- CodeRabbit is a manual fallback only through 2026-09-08. It requires Mitchell's named approval for that one run, confirmed flat-rate billing, usage-based add-ons disabled, automatic review disabled, and a one-review limit.
- Never run any hosted reviewer from a hook, scheduler, continuous-integration job, pull request comment, batch process, or unattended loop. Stop if billing or provider state is unclear.

BEFORE ACTION
- Read stack-ops/docs/qa-tiering.md and inspect stack-ops/src/router/pr-reviewer-triage.mjs when routing is involved.
- Run git status --short in the target repository or worktree. Preserve unrelated dirty work, but update stale QA instructions even when the file is already dirty.
- Do not commit or push unless Mitchell explicitly asks. Never stage personal data or secrets.

CACHE REFRESH
- State that this policy was loaded before action.
- Record the policy and the exact files or systems you inspected in your own session or memory mechanism. Do not overwrite another instance's memory and do not store secrets, keys, card details, or tokens.
- If you find any old hosted-review instruction, any metered reviewer instruction, or any default hosted gate, rewrite it to this policy or mark the record historical and non-executable.

RECEIPT
Report the changed files, exact commands, pass or fail results, skipped checks with reasons, provider and account type for any model call, and bounded failure reasons. Preserve factual incident history, but do not leave an executable copy of the retired QA workflow behind.

Start your response with the cache-refresh status, then list the planned scope, actions, verification, and any blocked items.
```

Knobs and assumptions:

- This is a policy-refresh prompt for already-running instances, not a request
  to spawn another orchestrator.
- The one-month CodeRabbit fallback ends on 2026-09-08 and remains manual.
- The prompt requires local evidence even when a hosted fallback is approved.
