---
name: research-router
description: Route a research request to the right modality — deep-research product, NotebookLM (Gemini Notebook), KB-RAG over a private corpus, or the multi-LLM council. Use when Mitchell says "research X", "look into X", "what's the current state of X", or any open-ended research ask, to pick the cheapest modality that fits before spending on the council.
---

# Research router

"Research" is not one thing. Route by task shape to the cheapest modality that fits;
reserve the paid council for genuinely ambiguous high-stakes judgment. These are
complementary, not substitutes.

## Decision

| If the task is… | Use | Why |
|---|---|---|
| fresh, cited, web-breadth facts (prices, versions, who-shipped-what) | **deep-research product** (Perplexity / Gemini / GPT deep research) | grounded + current; the council's grounded lanes are the same idea, cheaper as a single product |
| grounding + synthesis over a **fixed, vetted source set** + audio | **NotebookLM (Gemini Notebook)** | citation-anchored synthesis + Audio Overviews; low hallucination on its own sources |
| Q&A over a **private known corpus** (Mitchell's repos, past reports) | **KB-RAG** (RAG index over the export store) | private, no external hop; pairs with the content-level privacy gate |
| ambiguous, contested, high-stakes judgment where breadth of model perspectives matters | **the multi-LLM council** (`/council`) | parallel cross-model debate + dealbreaker adjudication; costs money → approval gate |

Default order: try deep-research or KB-RAG first; escalate to the council only when
the answer is contested or decision-critical.

## NotebookLM is a LAYER, not the system-of-record

NotebookLM (rebranded "Gemini Notebook", 2026-07-16) is a **synthesis + review +
audio** surface only. It is NOT the canonical store and NOT the final authoring
surface (no version control, silent truncation on long inputs).

- Vet sources BEFORE adding them (one notebook per project).
- **Canonical reports live in an external durable store** — Git / Drive / Obsidian
  markdown. NotebookLM's storage is a scratchpad.
- Agents **re-query via a separate RAG index over the EXPORTED files**, or via a
  local MCP bridge (`notebooklm-py` / `notebooklm-mcp-cli`) for still-active
  notebooks — treat that path as fragile, never load-bearing.
- Use it for: citation-anchored synthesis of a vetted set, a review/critique pass,
  and Audio Overviews. Do not use it as the authoring or storage system.

## Privacy

Before any external modality, run the request through `src/router/privacy-gate.mjs`.
Sensitive corpora (career-ops, employer material, secrets) → KB-RAG local only,
never a hosted deep-research product or a shared notebook.
