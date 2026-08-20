# Claude-Codex Review Bridge

A local, human-controlled bridge that sends completed Claude Code handoffs to a
persistent Codex review thread. Codex reviews the current application read-only;
the user decides whether to publish, edit, or discard its feedback.

The GitHub repository is a factory. Each application gets a separate reviewer
instance with its own Codex home, memories, sessions, policy, credentials, and
bridge state. An instance is permanently bound to one application repository.

```text
C:\dev\
|-- MyApp\
`-- MyApp-reviewer\
```

Keep the reviewer as a sibling, never inside the application repository.

## What it provides

- One isolated reviewer home per application
- Codex-guided generation of a private application review policy
- Persistent `manual` review mode with human approval by default
- One-shot and bounded automatic review modes
- Latest-checkpoint-wins handling when Claude finishes during a review
- Checkpoint-bound publication, cancellation, and recovery publication
- Streamed Stop-hook responses without polling
- Read-only injected Codex turns with live internet access
- Read-only advice on Claude's structured user questions
- Optional Playwright MCP integration for interface reviews
- A safe updater that preserves ignored reviewer state

## Requirements

- Windows PowerShell 5.1 or newer
- Git
- Node.js 22 or newer
- Claude Code available as `claude`
- Codex CLI available as `codex`
- A Git repository to review

The TypeScript runtime is portable, but the included factory, launch, and setup
scripts are currently Windows-first.

## Create an application reviewer

First clone this repository as a reusable factory checkout. From that checkout:

```powershell
.\scripts\New-ReviewerInstance.ps1 -ProjectRoot 'C:\dev\MyApp'
```

The factory checkout must be clean and synchronized with its upstream. This
prevents a locally newer factory script from cloning an older published template.
Commit and push factory changes before creating instances. An explicitly supplied
`-TemplateRepository` is still checked for the required instance workflow before
setup or authentication begins.

The default destination is `C:\dev\MyApp-reviewer`. Use `-Destination` to choose
another location outside the application. The factory:

1. clones a clean reviewer instance;
2. binds it permanently to the target repository;
3. installs and tests the bridge;
4. creates isolated Codex and Claude integration configuration;
5. authenticates the dedicated Codex home; and
6. starts `$bridge-init-policy` so Codex can inspect the application, ask only
   unresolved questions, preview a policy, and save it after approval.

If policy setup is cancelled, resume it from the generated instance:

```powershell
.\scripts\Start-PolicySetup.ps1
```

Pairing remains available without the application-specific policy, but prints a
warning and uses the tracked generic baseline.

## Start a workstream

From the generated reviewer instance:

```powershell
.\scripts\Start-Pair.ps1 -Feature 'your-feature-name'
```

This opens paired Claude and Codex terminals. The first Claude user prompt seeds
the persistent Codex thread once. Later checkpoints contain only Claude's latest
assistant message; Codex inspects the worktree for authoritative state.

When Claude uses `AskUserQuestion`, the structured question and choices are sent
to the same Codex thread for read-only advice. Claude continues waiting for the
user, who personally submits the final answer.

## Codex skills

- `$bridge-init-policy` - create or refresh the private application policy
- `$bridge-manual` - review every Claude Stop and wait for approval; default
- `$bridge-once` - review only the next Claude Stop
- `$bridge-auto` - allow up to three structured revise rounds
- `$bridge-off` - disable interception and question advice
- `$bridge-status` - inspect routing, mode, and checkpoint state
- `$bridge-publish` - publish the latest completed checkpoint review
- `$bridge-cancel` - release Claude without feedback
- `$bridge-force-publish` - recovery-only queueing when no Stop is held

Published feedback is advisory. Claude is instructed to challenge or adapt it,
accepting, changing, or rejecting findings based on project evidence.

## Policy and project context

Application knowledge remains in the target repository's `AGENTS.md`,
`CLAUDE.md`, architecture records, specifications, code, tests, and project
skills. The reviewer combines:

1. tracked [review-policy.md](review-policy.md), the generic baseline; and
2. ignored `review-policy.local.md`, generated privately for this application.

The application-specific overlay is never added to the application repository
or the public bridge template. Do not put secrets or credentials in it.

## Update an instance

From a generated reviewer instance with a clean tracked worktree:

```powershell
.\scripts\Update-ReviewerInstance.ps1
```

The updater fetches the configured upstream, accepts only a fast-forward update,
runs setup and tests again, and preserves ignored policy, authentication,
memories, sessions, runtime state, and feature mappings. It never resets or
overwrites tracked local changes. Pass `-Ref <remote-ref>` only when the current
branch has no configured upstream or a deliberate alternate ref is required.

## Security model

The broker listens on an ephemeral loopback port and requires a random bearer
token stored in ignored runtime state. Hook-injected Codex turns use a read-only
sandbox and never request approvals. Only the exact policy-writer MCP tool can
write `review-policy.local.md`, and Codex configuration prompts the user before
that tool runs. Generated Claude settings deny its normal tools access to the
reviewer home.

This is workflow isolation, not an operating-system security boundary. Both CLIs
run as the same operating-system user.

See [Bootstrap an application](docs/bootstrap-an-application.md) for recovery
and validation, and [Architecture](docs/architecture.md) for routing and state.

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE).
