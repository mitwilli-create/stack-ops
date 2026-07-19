# Stack map

A methodology for routing every request in a multi-model AI stack to whichever model
or tool research shows is actually best for it, instead of defaulting everything to
one assistant. Credentials and personal configuration never appear here; this is the
capabilities view.

## The problem

Most people run everything through a single subscription, by habit rather than
evidence. That is expensive and it wastes capability: a frontier reasoning model
spends the same premium tokens on a mechanical refactor as on a genuinely hard
architectural call, while cheaper models and specialized tools that are already paid
for sit unused. This stack inverts that. Toil goes to cheap capacity, judgment goes
to the model that is actually best at judgment, and the routing decision is made by a
lightweight classifier instead of by habit.

## The core doctrine

**Toil to open-weight, held-in-tension judgment to frontier.** A three-stage
pipeline: an open-weight model drafts, tests and static analysis gate the output, and
a frontier model reviews only the deltas that survive the gate and still look hard.
This is the most heavily corroborated finding in the research program: cheap
open-weight models are, in one researcher's phrase, "excellent labor, mediocre
judges." An empirical test backs it directly: a cheap 30B-class open-weight model in
the cloud swept the pure-mechanics tasks and degraded on tasks that required holding
two things in tension; the same model quantized on ordinary consumer hardware
produced nothing, because 30B-class models do not fit in memory the way spec sheets
imply.

**Frontier role-split**, once a task clears the needs-real-judgment bar:

- An Anthropic-class model: architecture, safe surgical multi-file edits, review, debug.
- An OpenAI-class model with an agentic coding variant: terminal tool-calling loops, background CI/CD, math.
- A Google-class model: long-context and multimodal work, and anything that benefits from deep cloud/productivity-suite integration.
- An xAI-class model: fresh web and social reconnaissance, prototyping. Deliberately not a default patch agent.
- An IDE-orchestration layer: the glue, not a reasoning source.

## Why auto-triage inside the IDE does not work

A tempting design lets the IDE read a prompt, classify it, and swap models per
request. It cannot, structurally: the IDE supports pointing at exactly one
OpenAI-compatible endpoint. The working pattern is an **external router behind that
one endpoint** — the IDE always talks to the same URL, and a thin service in front of
the real providers does the classification and dispatch. Recommended substrate: an
existing meta-router (an `auto` routing target) rather than a hand-rolled classifier,
reserving custom classification for the day the off-the-shelf router demonstrably
misroutes. A hand-rolled router looks like a weekend project until you hit streaming
passthrough and tool-call payload normalization, both quietly hard to get right.

One structural gotcha: IDEs that issue base-URL requests server-side will SSRF-block a
raw local address. A local router must sit behind a tunnel or a private-mesh DNS
hostname, never a bare `localhost`. This cost a full research pass to nail down
because four of five research lanes assumed raw localhost would work, and it does not.

## Layer map

**Frontier models** — one subscription/API per major lab, each assigned the task
classes above, plus a citation-grounded deep-research API as a distinct research
modality (not a general-purpose model).

**Open-weight toil tier** — a gateway aggregating several near-frontier open-weight
models, mostly permissively licensed, each independently verified to exist and carry
real adoption. This tier is the default target for anything a privacy classifier
clears as non-sensitive, and an independent adversarial cross-check in research work
(a different training lineage catches consensus errors a same-lineage panel shares).

**Media** — separate, purpose-built providers for text-to-speech, transcription,
audio editing, audio mastering, and image/video generation, rather than forcing a
general chat model to do media work it is mediocre at.

**Research and content-QA** — four complementary research modalities: live cited web
search for fresh facts; a grounded-notebook tool for static-corpus synthesis and
audio overviews (explicitly not the system of record, since it lacks version control
and can silently truncate); retrieval over a private known corpus; and a multi-model
debate council reserved for genuinely high-stakes ambiguous judgment, because it is
the most expensive modality and most questions do not need many independent opinions.
On QA: one AI-text detector with an independently verified low false-positive rate,
one plagiarism detector wired as a standing gate, and a decision to drop two redundant
detectors. Detection is triage plus a provenance trail plus a periodic human
benchmark, never a verdict on its own. A voice linter enforces the two hardest
house-style rules cheaply and always-on.

**Code-QA** — a tiered review stack: an always-on low-noise diff reviewer on every
repo; a full-codebase semantic reviewer added only on complex or high-blast-radius
repos; a merge-gate reviewer added only on production-critical repos, and only for
high-stakes changes. Hard anti-pattern, encoded in code: never run all three on a
trivial change, and never let "the bot found nothing" be the only required check. A
companion classifier decides which reviewers a change needs from diff size, files
touched, and whether it touches an auth, payment, security, or migration path.

**Infrastructure and MCP** — a tight foundational set of protocol-connected tools
(source control, browser automation, live library docs, semantic code search,
filesystem, sequential reasoning, web fetch) plus a domain set activated per project.
Explicit anti-pattern: too many active tool servers measurably degrades tool
selection, so the live set stays tight. Purpose-built internal tools get wrapped as
narrow protocol servers of their own, so any agent calls them like a third-party tool.

**Memory** — a three-layer hygiene frame: persistent memory outside the prompt,
aggressive compaction and pruning, and token/caching discipline that is measured
rather than assumed. Measurement surfaces the biggest lever: the majority of spend in
a long-lived coding-agent workflow is caching mechanics on large contexts, not raw
output, so the highest-leverage move is fewer, longer-lived sessions and compressing
noisy tool output before it enters context, not just shorter replies.

**Browser** — a stable Chromium daily driver plus one free AI-native browser, with a
paid alternative deferred. A formerly popular browser was ruled out after its maker
was absorbed in a large 2025 acquisition and the product moved to maintenance mode: a
good reminder that a stack map needs a re-verification date, not permanence.

**Hosting and remote access** — personal hardware behind a private mesh VPN is the
privacy gold standard for a secrets-adjacent stack, reached from any external tool
through a tunnel or a private DNS hostname rather than a raw local address. A low-cost
VPS behind the same mesh, zero public ports, is the uptime fallback. Shared hosting
was evaluated and rejected.

## What is built

**A content-level privacy gate and a PR-review triage router**, both pure,
dependency-free, and unit-tested. The privacy gate replaced an earlier blanket rule
("this whole repository is sensitive") with a per-request signal check for secrets,
personal data, private paths, and confidentiality markers. That is both safer
(catches sensitive content inside an otherwise-generic repo) and cheaper (generic work
routes to the cheap tier even inside a sensitive project). On ambiguous or malformed
input it fails closed. The PR-review triage router runs the same classify-signals
pattern against the code-QA tiering above.

**An upgraded multi-model research engine, shipped through review.** Unstaled model
references with fallback chains, an open-weight provider, media dispatch targets, and
a physical separation between the research-debate lineup and the task-routing policy
table (previously one entangled code path). It went through the same pull-request
discipline as everything else, with a bot-review loop to zero findings before merge.
Specifying the change first and shipping it slowly is part of the methodology: a
routing engine is exactly the shared infrastructure where an unreviewed change has the
highest blast radius, so it gets the most-reviewed path to production, not the fastest.

**A narrow protocol server wrapping that engine's routing policy**, so any agent can
ask "what should this task go to?" without importing the engine or spending anything.

## How decisions get made

Every non-trivial pick goes through one pipeline: a multi-model council fans a
question out to a provider-neutral panel in parallel; an adjudication pass checks every
contested claim against an authoritative source (repository metadata, a live search, a
primary document) rather than counting how many models agreed; the adjudicated
findings get walked past a human one at a time rather than dumped as a wall of text;
and only approved decisions become a build spec. The adjudication earns its keep:
across one full cycle, the models flagged least trustworthy (single live source rather
than several models agreeing) were the most accurate, while several "corroborated"
claims turned out to be one model's guess echoed by others that never checked it. The
lesson generalizes: model agreement is not verification, and a claim that starts as a
prompt hypothesis does not become true because models repeat it back with a hedge.

---

*Last verified 2026-07-19. Re-verify model names, adoption, and pricing before relying
on any of them; a methodology map ages slower than the specifics inside it.*
