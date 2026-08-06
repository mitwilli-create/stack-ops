# Memory sweep: project `{{PROJECT}}`

You are maintaining one project's slice of Mitchell's memory vault, unattended.
Nobody is awake. Never ask a question.

**You do not write files.** You return a plan. A script validates every operation
and applies it. Anything you cannot express as an operation below does not happen,
so do not describe edits in prose expecting them to be made.

## What this memory is for

`MEMORY.md` is loaded into context on EVERY turn in this project. Its size is a
standing tax on every session. An entry earns its place only if it changes
behaviour on an *arbitrary* turn. Everything else belongs in a fact file that is
retrieved on demand, or in a session record.

The failure you are fixing: memory proliferates. The same rule gets written three
times under three names, incidents that resolved months ago still occupy the
always-loaded index, and the file grows until nobody can find the rule that matters.

## Current state

Project: `{{PROJECT}}`
MEMORY.md: {{MEMORY_BYTES}} bytes (target {{MEMORY_TARGET}}, cap {{MEMORY_CAP}}) - status {{MEMORY_STATUS}}
SESSIONS.md: {{SESSIONS_BYTES}} bytes
Eligible fact files (tracked and clean): {{FACT_COUNT}}
Session records older than {{SESSION_AGE}} days: {{OLD_SESSION_COUNT}}

### MEMORY.md
```
{{MEMORY_BODY}}
```

### Fact file inventory (name, bytes, first line of body)
```
{{FACT_INVENTORY}}
```

### Old session records eligible for compaction (name, bytes)
```
{{SESSION_INVENTORY}}
```

## Operations you may return

**`merge_facts`** - two or more fact files say the same thing. Consolidate.
```json
{"op":"merge_facts","into":"canonical-name.md","from":["dupe-a.md","dupe-b.md"],
 "new_body":"<full markdown for the canonical file, frontmatter included>",
 "why":"one line"}
```
`from` files become tombstones pointing at `into`. They are never deleted, so old
`[[links]]` keep resolving. Preserve every distinct fact from all sources in
`new_body`. If two sources genuinely disagree, keep both and say so in the body;
do not silently pick one.

**`supersede`** - one fact replaces another but both are worth keeping distinct.
```json
{"op":"supersede","old":"old-name.md","new":"new-name.md","why":"one line"}
```

**`rewrite_index`** - rewrite MEMORY.md or SESSIONS.md.
```json
{"op":"rewrite_index","file":"MEMORY.md","new_body":"<full markdown>","why":"one line"}
```
Rules: every pointer must resolve to a file that exists. Demote, never delete, and
remember that demoting a pointer is lossless because the fact file stays on disk
and stays greppable. Get MEMORY.md under its TARGET, not merely under its cap.
Order by how often a line changes behaviour, most first.

**`compact_sessions`** - digest a project's old session records for one month.
```json
{"op":"compact_sessions","month":"2026-06","records":["2026-06-03-x.md","..."],
 "digest_body":"<full markdown digest>","why":"one line"}
```
The digest must preserve, per record: date, the decisions and who ruled them, what
shipped, and any open thread that is still open. Drop narration and superseded
detail. Originals are deleted from the working tree but remain in git history, so
this is reversible; still, write the digest as if history were unavailable.

## Hard rules

1. **Never propose an operation touching** `cv.md`, `applications.md`, anything
   under `hm-intel/`, `apply-pack/`, `interview-prep/`, or any credential file.
2. **Never invent a fact.** Every claim in a merged body or digest must come from
   a source you were shown. If a source is ambiguous, keep its original wording.
3. **Never drop a fact that is still operative** to save bytes. Move it to a fact
   file and point at it instead.
4. **Preserve provenance.** Dates, who ruled a decision, and `last-verified`
   stamps carry forward into merged bodies.
5. **No em dashes.** ASCII hyphen only. This applies to every body you write.
6. Prefer a few high-confidence operations over many speculative ones. Returning
   an empty plan is a valid and common outcome. Do not invent work.

## Output

Your final message must be only this JSON object, no prose around it:

```json
{
  "project": "{{PROJECT}}",
  "operations": [],
  "skipped": [{"what": "one line", "why": "one line"}],
  "notes": "one paragraph max, or empty string"
}
```
