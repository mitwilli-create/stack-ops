# stack-ops

An automatic, research-validated **model-triage system** for a multi-vendor AI stack: route each task to
the model or tool that independent, practitioner-sourced research shows is genuinely best for it. Cheap
open-weight models for menial/toil work, frontier labs for deep and surgical work, media models for their
own modalities, so output quality per dollar is maximized instead of streaming everything through one
vendor.

## Why

Most builders default to a single assistant for everything. That leaves capability on the table (other
models are genuinely better at specific task classes) and money on the table (menial work doesn't need
frontier tokens). This project treats routing as an engineering problem: research what each model actually
wins at, encode that into a triage layer, and operate from an editor where the right model just shows up.

## What's here (as it lands)

- **Capability maps**: where open-weight/Chinese models succeed, break, and are best used; and where each
  frontier lab is optimally suited relative to the rest of the market. Sourced from practitioner discussion
  (forums, issue threads, repos), favoring open-source and highly-endorsed tools over reinvention.
- **Triage methodology**: how tasks are classified and routed.
- **Workspace setup**: the editor/workspace configuration that operationalizes the triage.

## Safety

This repository is designed so secrets **cannot** live in it: all API keys, credentials, personal
configuration, and confidential material stay in a gitignored private layer and are never committed. Every
publish passes a mandatory secret scan over the full tree and git history, plus an explicit file-list
review, first.

> Status: in active development. Public artifacts publish after the build phase is complete and reviewed.
