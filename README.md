# Claude-Codex Review Bridge

A local, human-controlled bridge that sends completed Claude Code handoffs to a
persistent Codex review thread. Codex reviews the current application read-only;
the user decides whether to publish, edit, or discard its feedback.

The GitHub repository is a factory. Each application gets a separate reviewer
instance with its own Codex home, memories, sessions, policy, credentials, and
bridge state. An instance is permanently bound to one application repository.

```text
dev/
|-- MyApp/
`-- MyApp-reviewer/
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

- Windows PowerShell 5.1+ or Bash
- Git
- Node.js 22 or newer
- Claude Code available as `claude`
- Codex CLI available as `codex`
- A Git repository to review

[`just`](https://just.systems/) 1.52 or newer is optional. When installed, the root
`justfile` provides the same commands on Windows, Linux, and macOS without
choosing a platform-specific wrapper.

Windows, native Linux, and macOS are supported. WSL uses the Linux workflow on a
best-effort basis; when a graphical terminal cannot be launched, the bridge
prints the two commands to run manually.

## Create an application reviewer

First clone this repository as a reusable factory checkout. From that checkout:

```powershell
.\scripts\powershell\reviewer.ps1 create --project-root 'C:\dev\MyApp'
```

```bash
./scripts/shell/reviewer.sh create --project-root /home/me/dev/MyApp
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
.\scripts\powershell\reviewer.ps1 policy
```

```bash
./scripts/shell/reviewer.sh policy
```

Pairing remains available without the application-specific policy, but prints a
warning and uses the tracked generic baseline.

## Start a workstream

From the generated reviewer instance:

```powershell
.\scripts\powershell\reviewer.ps1 start-pair --feature 'your-feature-name'
```

```bash
./scripts/shell/reviewer.sh start-pair --feature your-feature-name
```

This opens paired Claude and Codex terminals. The first Claude user prompt seeds
the persistent Codex thread once. Later checkpoints contain only Claude's latest
assistant message; Codex inspects the worktree for authoritative state.

`start-pair` automatically opens two PowerShell windows on Windows, Terminal on
macOS, or a recognized graphical terminal on Linux. Use `--terminal print` (or
PowerShell `--terminal print`) to print the exact two commands instead. Arguments
after `--` are forwarded unchanged to Claude:

```bash
./scripts/shell/reviewer.sh start-pair --feature api-retry -- --model opus
```

PowerShell consumes the literal `--` before a script can receive it, so its
wrapper provides `--passthrough` as the equivalent delimiter:

```powershell
.\scripts\powershell\reviewer.ps1 start-pair --feature api-retry --passthrough --model opus
```

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
.\scripts\powershell\reviewer.ps1 update
```

```bash
./scripts/shell/reviewer.sh update
```

The updater fetches the configured upstream, gracefully stops the running
broker, accepts only a fast-forward update, runs setup and tests again, and
preserves ignored policy, authentication, memories, sessions, runtime state,
and feature mappings. It never resets or
overwrites tracked local changes. Pass `-Ref <remote-ref>` only when the current
branch has no configured upstream or a deliberate alternate ref is required.
The Bash equivalent is `--ref <remote-ref>`.

## Optional Just commands

Run `just` to list the available recipes. The common workflow becomes:

```text
just create /path/to/MyApp
just policy
just pair my-feature
just server
just stop
just update
```

On Windows, paths may use their normal drive-letter form, for example
`just create 'C:\dev\MyApp'`. Put a `--` before options or arguments that begin
with a dash. For example, Claude arguments after the feature name are forwarded
unchanged:

```text
just pair api-retry -- --model opus
```

Factory or reviewer options use the same convention:

```text
just create /path/to/MyApp -- --destination /path/to/MyApp-reviewer
just update -- --ref origin/main
```

Use `just reviewer -- <command> ...` as an escape hatch for any command exposed
by `scripts/reviewer.mjs`. The PowerShell and Bash entrypoints remain fully
supported and do not require Just.

## Releases

Releases are deliberate. Merging to `main` runs validation but does not publish
a version. To release, manually run the **CI** workflow against `main`; its
semantic-release job starts only after the quality and compatibility jobs pass.

The release job authenticates as a dedicated GitHub App installed only on this
repository. It reads `RELEASE_APP_CLIENT_ID` from the repository variables and
`RELEASE_APP_PRIVATE_KEY` from the Actions secrets, then creates a short-lived
installation token with repository contents write access. The App must have
always-allow bypass access to the protected `main` branch and `v*` tags.

Semantic-release derives the next version from Conventional Commit messages,
updates `package.json` and `package-lock.json`, creates a release commit and
`vX.Y.Z` tag, and publishes GitHub release notes. The package is private and is
never published to npm. Do not edit the package version manually.

- `fix:` creates a patch release.
- `feat:` creates a minor release.
- A breaking-change footer or `!` creates a major release.
- Documentation, test, and maintenance-only commits do not create a release.

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
