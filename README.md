# Claude-Codex Review Bridge

A local, human-controlled bridge that sends completed Claude Code handoffs to a
persistent Codex review thread. Codex reviews the current project read-only;
the user decides whether to publish, edit, or discard its feedback.

The bridge forwards only Claude's latest assistant message plus the initial
workstream prompt. It does not copy the full Claude transcript, and it keeps one
Codex thread per named workstream so review context survives planning,
specification, implementation, and verification checkpoints.

## What it provides

- Persistent `manual` review mode with human approval by default
- One-shot and bounded automatic review modes
- Latest-checkpoint-wins handling when Claude finishes again during a review
- Checkpoint-bound publish and cancel operations
- Recovery publication after a terminal restart or manually pasted handoff
- Streamed Stop-hook responses with 30-second heartbeats
- Read-only injected Codex turns with live internet access
- Read-only advice on Claude's structured user questions
- Optional Playwright MCP integration for interface reviews
- Private reviewer instructions stored outside the target repository

## Requirements

- Windows PowerShell 5.1 or newer
- Node.js 22 or newer
- Claude Code available as `claude`
- Codex CLI available as `codex`
- A Git repository to review

The TypeScript runtime is portable, but the included launch and setup scripts
are currently Windows-first.

## Quick start

Keep this folder outside the application repository. From this folder:

```powershell
.\scripts\Setup-ReviewBridge.ps1 -ProjectRoot 'C:\path\to\your-app'
.\scripts\Initialize-Reviewer.ps1
.\scripts\Start-Pair.ps1 -Feature 'your-feature-name'
```

The first command installs dependencies, builds and tests the bridge, and
generates ignored machine-local files:

- `bridge.local.json` — target project path and display name
- `config.toml` — dedicated Codex home, permissions, and MCP configuration
- `claude-bridge.settings.json` — Claude hooks and reviewer-folder deny rules

The second command authenticates the dedicated Codex home. The third opens
paired Claude and Codex terminals and resumes their stored sessions when the
same feature name is reused.

Submit the initial product or task prompt in Claude. `UserPromptSubmit` seeds it
into Codex once. Each subsequent Claude Stop becomes a checkpoint in the same
Codex thread.

When Claude uses its structured `AskUserQuestion` UI while the bridge is armed,
the generated `PreToolUse` hook sends only that question and its choices to the
same Codex thread. Claude's UI continues normally and waits for you; the hook
does not approve the tool or inject an answer. Codex starts a read-only advisory
turn so you can inspect and discuss its recommendation, then personally answer
Claude. Question advisories never become publishable review checkpoints.

## Bridge commands

Invoke these through Codex skills:

- `$bridge-manual` — review every Claude Stop and wait for approval; default
- `$bridge-once` — review only the next Claude Stop
- `$bridge-auto` — allow up to three structured revise rounds
- `$bridge-off` — disable interception and question advice, and release any held Stop
- `$bridge-status` — inspect routing, mode, and checkpoint state
- `$bridge-publish` — publish the latest completed checkpoint review
- `$bridge-cancel` — release Claude without feedback
- `$bridge-force-publish` — recovery-only queueing when no Stop is held

Text after `$bridge-publish` is treated as an edit instruction unless introduced
with `send exactly`, `verbatim feedback`, or `replace the review with`. The skill
must compose the final review instead of sending editing instructions to Claude.

Published feedback is advisory. Claude is instructed to challenge or adapt it,
accepting, changing, or rejecting findings based on project evidence.

## Customize the reviewer

Application knowledge belongs in two places:

1. The target repository's normal `AGENTS.md`, `CLAUDE.md`, architecture records,
   specifications, and project skills.
2. This folder's private [review-policy.md](review-policy.md), for checks or
   review priorities that should not be visible in the application repository.

Do not add application names, paths, or domain policy to the TypeScript runtime.
Re-run setup after moving this folder or changing the target project path.

See [Bootstrap another application](docs/bootstrap-an-application.md) for the
complete integration and validation checklist, and [Architecture](docs/architecture.md)
for routing, state, recovery, and security details.

## Security model

The broker listens on an ephemeral loopback port and requires a random bearer
token stored in ignored runtime state. Injected Codex turns use a read-only
sandbox and never request approvals. The generated Claude settings deny normal
Claude tools access to this reviewer home.

This is local workflow isolation, not an operating-system security boundary.
Both CLIs still run as the same operating-system user. Keep authentication,
runtime state, logs, and private prompts out of source control.

## Project maturity

Before a broader release, add CI for supported Node and PowerShell versions,
document the tested Claude Code and Codex CLI versions, and perform a security
review of the local hook and bearer-token boundary.

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE).
