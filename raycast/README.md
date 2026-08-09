# Raycast integration

These Script Commands make Raycast the local intake surface for Stack Ops.

## Add the commands

In Raycast, open Settings, choose Extensions, select Script Commands, and add
this repository's `raycast/` directory. Raycast indexes the two commands:

- `Stack Ops Ask` dispatches a request after the local privacy and capability
  route is resolved.
- `Stack Ops Route` shows the route without making a model call.

The command scripts derive the repository root from their own location, so the
directory can be moved without editing a personal path into the repository.

## Routing contract

- Bounded renaming, organizing, transfer, formatting, extraction, and triage
  go to the ZDR-constrained open-weight execution path.
- Research, social retrieval, multimodal input, long-context work, coding, and
  high-judgment requests select one capability-specific frontier handle and
  keep a compatible fallback.
- Privacy-gated input stays local and is refused before any external call.

The route command is the verification surface. It exposes the selected handle,
task class, signals, evidence pointer, and confidence without spending.

## Console

Run npm run console to serve the console at
http://127.0.0.1:3939. The Raycast command installs or refreshes a per-user
launchd wrapper, waits for the health endpoint, and opens the browser. The
wrapper starts at login and keeps the server independent of Raycast. Sessions
are stored outside this repository in the macOS application support directory
unless STACK_OPS_STATE_DIR is set.

The console assembles the canonical llm-memory files and relevant skills
before an external dispatch. It displays only
counts and route metadata in the browser trace. MCP entries are read from
.mcp.json, with credential values kept out of the response.
