# Token discipline

The measurement + compression layer of the three-part hygiene frame (persistent
memory + aggressive compaction/pruning + token/caching discipline **with
measurement**). You cannot cut what you do not measure.

## Metering: ccusage

[`ccusage`](https://www.npmjs.com/package/ccusage) (v20+) reads local coding-CLI
usage data and reports token + cost breakdowns by day, model, and session across
15+ agents. No account or API key; it reads what is already on disk.

```bash
npx -y ccusage@latest daily        # per-day tokens + cost, by model
npx -y ccusage@latest session      # per-session
npx -y ccusage@latest monthly
```

Wire it as a shell alias (`alias ccu='npx -y ccusage@latest'`) so a usage check is
one keystroke. Run it weekly; watch the **cache-read** columns, not just output.

**The dominant finding it surfaces:** the overwhelming majority of spend is
*caching mechanics* (cache reads/writes on large, long-lived contexts), not model
output. The lever is therefore **context size and cache hit rate**, which is what
the compression tool below targets. Practical consequences: prefer fewer,
longer-lived sessions; compact rather than re-spawn; batch subagent fan-out.

## Compression: rtk (picked) vs caveman (deferred)

Two real, high-adoption token-reduction tools were evaluated. They attack
*different* halves of the token budget:

| Tool | Attacks | Mechanism | Reduction (vendor-reported) |
|---|---|---|---|
| **rtk** (rtk-ai/rtk) | **input / context** | CLI proxy that filters + compresses noisy *command output* (test runs, builds, greps, logs) before it enters context; code/errors preserved | 60-90% on dev-command output |
| caveman (JuliusBrussee/caveman) | output | Compresses the *model's replies* into fragment-style prose; code/errors byte-exact | ~65% output tokens |

**Pick: rtk.** Since metering shows spend is dominated by context/input and cache
mechanics (not output), the higher-leverage tool is the one that shrinks the noisy
command output bloating context. rtk is a transparent single binary, low
integration friction, and its 60-90% reduction lands squarely on the biggest cost
driver. caveman is a genuine complement (output side) and is **deferred**, not
dropped, per the "pick one" ruling.

> Eval depth: this pick is reasoned from tool design + the measured spend profile,
> not a full A/B benchmark. Validate rtk on a week of real workload (meter with
> ccusage before/after) before committing; revisit caveman if output tokens turn
> out to be a larger share than the current profile suggests.

Reduction numbers are vendor-reported — measure your own before/after with ccusage.
