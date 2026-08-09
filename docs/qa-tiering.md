# QA tiering

The default QA path is free, local, and deterministic. Paid review services are
never automatic.

## Code QA

Every change follows this order:

1. Run the repository's tests.
2. Run the repository's lint, type check, and static or security checks.
3. Run `git diff --check`.
4. Use `verification-before-completion` to confirm the checks actually exercised
   the changed behavior.
5. Use `mp-code-review` or `requesting-code-review` for a second perspective when
   the change is large, high-risk, or has a written specification.

These checks use the repository toolchain and local review skills. They do not
create a separate per-review vendor charge.

### External review policy

The router's default result is two local reviewers: `local-gates` and
`local-review-skill`. No hosted reviewer is a required merge check.

Qodo is fully halted. It must not be invoked, re-authenticated, connected to a
repository, or used as a merge gate. Greptile is blocked in the router as well.

CodeRabbit is a temporary manual fallback through 2026-09-08 only. It requires
Mitchell's approval for that specific run, a named provider, confirmed flat-rate
billing with usage-based add-ons disabled, `automatic: false`, and a one-review
limit. It must not run from a hook, scheduler, continuous-integration job, pull
request comment, or unattended loop.

### Cost controls

- Disable CodeRabbit's pay-as-you-go or usage-based add-on in its organization
  billing settings.
- Keep Qodo disconnected and deleted. Do not restore its integrations.
- Keep automatic review disabled in every `.coderabbit.yaml`.
- Do not use `@coderabbitai review`, Qodo review commands, Greptile, or hosted
  reviewer buttons inside an unattended loop.
- Stop a run when the provider exposes a usage warning, overage state, or unclear
  billing mode.

## Content QA

Keep the existing deterministic content gates and human review. Detector output
is triage, not truth, and no paid detector may become a blocking default without
an explicit budget and a measured false-positive rate.

## Voice linting

`vale` validates prose against the voice rules. The byte-level prose scan remains
the final check because Markdown parsing can omit inline text. Run both before
shipping outward-facing material.

## Router contract

`src/router/pr-reviewer-triage.mjs` is the policy source. Its default result is:

```js
{
  reviewers: ['local-gates', 'local-review-skill'],
  mergeGate: null,
}
```

The CodeRabbit fallback requires `allowPaidReviewers: true`, a one-item
`paidReviewers` list, and a `hostedApproval` object that names CodeRabbit,
sets `billingMode: 'flat-rate'`, sets `automatic: false`, sets `maxReviews: 1`,
and supplies a valid approval end date from the current date through
2026-09-08. The router never routes Qodo or Greptile.
