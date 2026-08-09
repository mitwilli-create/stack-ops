# Cross-CLI integration

The coordinator is provider-neutral. Claude Code, Codex, Antigravity, and Grok
all report into the same lease, activity, checkpoint, publication, deployment,
and receipt state. This prevents the automation from making different safety
decisions merely because a different model opened the worktree.

## Coverage

| Client | Live activity signal | Automatic publication path |
| --- | --- | --- |
| Claude Code | Existing `PostToolUse` hooks call `cli-heartbeat.zsh`; process and file observation remain active | Coordinator checkpoint, verification, push, draft pull request, and manifest deploy |
| Codex | Current local command surface exposes no lifecycle hook; process working directory and file observation cover the session | Same coordinator path; `cli-session-wrapper.zsh codex ...` adds periodic heartbeats when desired |
| Antigravity | Current local command surface exposes no lifecycle hook; process working directory and file observation cover the session | Same coordinator path; `cli-session-wrapper.zsh agy ...` adds periodic heartbeats when desired |
| Grok | Current local command surface exposes no lifecycle hook; process working directory and file observation cover the session | Same coordinator path; `cli-session-wrapper.zsh grok ...` adds periodic heartbeats when desired |

The observer is the common fallback. A client without hooks is not excluded and
does not get a weaker publication policy. If process liveness cannot be
verified, abandoned work is held rather than guessed at.

## Claude Code hook

The installation step adds this command to the existing `PostToolUse` write
hook and keeps the existing routing and memory hooks intact:

```sh
"$HOME/Documents/stack-ops/scripts/instance-shipping/cli-heartbeat.zsh"
```

The command is best-effort and exits quickly. It never performs Git mutation.

## Clients without hooks

Use the wrapper for a session where a periodic heartbeat is useful:

```sh
"$HOME/Documents/stack-ops/scripts/instance-shipping/cli-session-wrapper.zsh" codex exec --sandbox workspace-write "..."
"$HOME/Documents/stack-ops/scripts/instance-shipping/cli-session-wrapper.zsh" agy --print --mode accept-edits "..."
"$HOME/Documents/stack-ops/scripts/instance-shipping/cli-session-wrapper.zsh" grok --single --permission-mode auto "..."
```

The wrapper does not alter the client command or model. It only sends a
heartbeat before launch and every 30 seconds while the client process remains
alive. The one-minute observer still performs the same classification if a
wrapper is not used.
