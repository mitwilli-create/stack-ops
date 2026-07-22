#!/usr/bin/env node
/**
 * routing-report.mjs: what actually routed, and what it cost.
 *
 * WHY THIS EXISTS. The cheap tier was built, verified working end to end, and
 * then used exactly once. The failure was never capability; it was that nobody
 * could see the gap. "Adoption is low" is an opinion. "3 routed rows last week
 * against 40 delegatable tasks" is a number you can act on.
 *
 * Mitchell ruled 2026-07-22 that all four measures matter, so this reports all
 * four rather than picking a headline:
 *   1. routed rows per week          (the adoption trend)
 *   2. percent of delegatable work   (the gap; needs a denominator, see below)
 *   3. dollars saved vs frontier     (the concrete but smaller half)
 *   4. escalations                   (the leak, because auto-escalation is now
 *                                      on and must not quietly become normal)
 *
 * ON THE DENOMINATOR. This script can only see what reached the CLI. Work that
 * should have routed and was done inline is invisible to it by construction, so
 * measure 2 is reported as "of what reached the CLI", never as a true
 * percentage of delegatable work. Overstating it would be exactly the kind of
 * green-check-that-cannot-go-red this repo bans. The honest denominator needs a
 * separate signal; until then this reports the count and says what it cannot see.
 *
 * Read-only. Never writes, never calls a model, never needs a key.
 *
 * Usage:
 *   node scripts/routing-report.mjs                # last 8 weeks
 *   node scripts/routing-report.mjs --weeks 4
 *   node scripts/routing-report.mjs --json
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const LOG = process.env.CHEAP_DECISION_LOG || join(homedir(), '.claude', 'logs', 'cheap-decisions.jsonl');

// Blended $/Mtok for the frontier model this work would otherwise have used.
// Deliberately conservative: understating the baseline understates the saving,
// which is the safe direction for a number used to justify the tier.
const FRONTIER_BLENDED_PER_MTOK = Number(process.env.FRONTIER_BLENDED_PER_MTOK) || 30;

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const weeks = Number(args[args.indexOf('--weeks') + 1]) || 8;

if (!existsSync(LOG)) {
  console.error(`routing-report: no decision log at ${LOG}. Nothing has routed yet.`);
  process.exit(1);
}

const rows = readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map(l => {
  try { return JSON.parse(l); } catch { return null; }   // a torn write must not kill the report
}).filter(Boolean);

const cutoff = Date.now() - weeks * 7 * 86400_000;
const recent = rows.filter(r => r.ts && Date.parse(r.ts) >= cutoff);

const isoWeek = ts => {
  const d = new Date(ts);
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return `${t.getUTCFullYear()}-W${String(Math.ceil(((t - y0) / 86400_000 + 1) / 7)).padStart(2, '0')}`;
};

const tok = r => r.usage?.total_tokens || 0;
const cost = r => r.usage?.cost || 0;

const byWeek = new Map();
for (const r of recent) {
  const w = isoWeek(r.ts);
  if (!byWeek.has(w)) byWeek.set(w, { week: w, routed: 0, escalated: 0, refused: 0, failed: 0, tokens: 0, spend: 0 });
  const b = byWeek.get(w);
  if (r.outcome === 'ok') { b.routed++; b.tokens += tok(r); b.spend += cost(r); }
  else if (r.outcome === 'escalated') { b.escalated++; b.tokens += tok(r); b.spend += cost(r); }
  else if (r.outcome === 'refused') b.refused++;
  else b.failed++;
}
const series = [...byWeek.values()].sort((a, b) => a.week.localeCompare(b.week));

const routed = recent.filter(r => r.outcome === 'ok');
const escalated = recent.filter(r => r.outcome === 'escalated');
const cheapTokens = routed.reduce((a, r) => a + tok(r), 0);
const cheapSpend = routed.reduce((a, r) => a + cost(r), 0);
const escSpend = escalated.reduce((a, r) => a + cost(r), 0);
const wouldHaveCost = (cheapTokens / 1e6) * FRONTIER_BLENDED_PER_MTOK;

const byTask = {};
for (const r of routed) {
  const k = r.task || '(untagged)';
  byTask[k] = byTask[k] || { calls: 0, tokens: 0, spend: 0, models: new Set() };
  byTask[k].calls++; byTask[k].tokens += tok(r); byTask[k].spend += cost(r);
  if (r.served) byTask[k].models.add(r.served);
}

const refusalReasons = {};
for (const r of recent.filter(x => x.outcome === 'refused')) {
  const k = r.reason || r.reasons?.[0]?.signal || 'unknown';
  refusalReasons[k] = (refusalReasons[k] || 0) + 1;
}

const report = {
  log: LOG, weeks, generated_from_rows: recent.length,
  routed: routed.length,
  escalated: escalated.length,
  refused: recent.filter(r => r.outcome === 'refused').length,
  cheap_tokens: cheapTokens,
  cheap_spend_usd: +cheapSpend.toFixed(5),
  escalation_spend_usd: +escSpend.toFixed(5),
  frontier_equivalent_usd: +wouldHaveCost.toFixed(4),
  saved_usd: +(wouldHaveCost - cheapSpend).toFixed(4),
  savings_ratio: cheapSpend > 0 ? +(wouldHaveCost / cheapSpend).toFixed(1) : null,
  weekly: series,
  by_task: Object.fromEntries(Object.entries(byTask).map(([k, v]) => [k, { ...v, models: [...v.models] }])),
  refusal_reasons: refusalReasons,
};

if (asJson) { console.log(JSON.stringify(report, null, 2)); process.exit(0); }

const money = n => '$' + n.toFixed(n < 1 ? 5 : 2);
console.log(`\nRouting report, last ${weeks} weeks, ${LOG}\n${'='.repeat(64)}`);

if (!recent.length) {
  console.log('\nNOTHING ROUTED IN THIS WINDOW.\n');
  console.log('The tier is built and idle. Route bulk toil with:');
  console.log('  cheap --task <bulk_summarize|log_triage|structured_extraction|');
  console.log('               bulk_mechanical_edit|boilerplate_generation|long_context> --files ...\n');
  process.exit(0);
}

console.log('\nWeekly trend');
console.log('  week       routed  escal  refused  failed     tokens      spend');
for (const w of series) {
  console.log(`  ${w.week}  ${String(w.routed).padStart(6)} ${String(w.escalated).padStart(6)} ${String(w.refused).padStart(8)} ${String(w.failed).padStart(7)} ${String(w.tokens).padStart(10)}  ${money(w.spend).padStart(9)}`);
}

console.log(`\nTotals`);
console.log(`  routed to cheap tier   ${report.routed} call(s), ${cheapTokens.toLocaleString()} tokens, ${money(cheapSpend)}`);
console.log(`  escalated to frontier  ${report.escalated} call(s), ${money(escSpend)}`);
console.log(`  refused by the gate    ${report.refused}`);
console.log(`  frontier equivalent    ${money(wouldHaveCost)} (at $${FRONTIER_BLENDED_PER_MTOK}/Mtok blended)`);
console.log(`  saved                  ${money(report.saved_usd)}${report.savings_ratio ? `  (${report.savings_ratio}x cheaper)` : ''}`);

if (Object.keys(byTask).length) {
  console.log(`\nBy task archetype`);
  for (const [k, v] of Object.entries(byTask).sort((a, b) => b[1].calls - a[1].calls)) {
    console.log(`  ${k.padEnd(24)} ${String(v.calls).padStart(3)} call(s)  ${String(v.tokens).padStart(9)} tok  ${money(v.spend).padStart(9)}  ${[...v.models].join(', ')}`);
  }
}

if (Object.keys(refusalReasons).length) {
  console.log(`\nWhy the gate refused`);
  for (const [k, n] of Object.entries(refusalReasons).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(30)} ${n}`);
  }
}

// The escalation rate is the number that decides whether auto-escalation stays
// on. If it climbs, the cheap tier is failing and the "cheap" path is quietly
// becoming a frontier path with extra steps.
const attempted = report.routed + report.escalated;
if (attempted > 0) {
  const rate = (report.escalated / attempted) * 100;
  console.log(`\nEscalation rate: ${rate.toFixed(1)}% of attempted calls fell through to frontier.`);
  if (rate > 20) console.log('  ⚠️  Above 20%. The cheap rungs are failing often enough to question the ladder.');
}

console.log(`\nWhat this CANNOT see: work that should have routed and was done inline`);
console.log(`instead. There is no denominator for that here, so treat the routed`);
console.log(`count as a floor on adoption, never as a percentage of what could route.\n`);
