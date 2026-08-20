# Bootstrap another application

This bridge is designed as a private reviewer home paired with one target
application. Repeat the process with a separate bridge folder when applications
need different reviewer policies, credentials, or tool integrations.

## 1. Place the reviewer outside the application

Copy or clone this folder beside the target repository, not inside it. Keeping
the reviewer separate prevents its prompt, skills, authentication, and runtime
state from becoming part of the application's normal Claude context.

Do not commit generated `config.toml`, `bridge.local.json`,
`claude-bridge.settings.json`, `runtime/`, or Codex authentication files.

## 2. Prepare project-readable context

Codex should learn the application from the same authoritative artifacts used
by maintainers:

- root and component `AGENTS.md` or `CLAUDE.md` files;
- architecture decision records and specifications;
- plans or change artifacts;
- project-owned skills relevant to the affected domain;
- code, tests, migrations, and the current diff.

Put routing instructions in the target repository's root guidance. Explain
where architecture decisions, specifications, and component instructions live.
Avoid copying large project manuals into the bridge.

## 3. Add private review policy

Edit `review-policy.md` when the independent reviewer needs checks that should
remain outside the application repository. Keep it concise and procedural.

Useful additions include:

- mandatory commands or evidence for security-sensitive areas;
- required browser routes, breakpoints, themes, and test accounts;
- architecture boundaries that commonly regress;
- how to distinguish blocking findings from suggestions;
- conditions that require `needs_user` in automatic mode.

Do not paste application secrets, production credentials, or another review
agent's conclusions into the policy.

## 4. Generate the local integration

Run from the bridge folder:

```powershell
.\scripts\Setup-ReviewBridge.ps1 `
  -ProjectRoot 'C:\path\to\your-app' `
  -ProjectName 'Your App'
```

Use `-SkipPlaywright` for projects that do not require browser review. Setup:

1. verifies Node, npm, Claude Code, Codex CLI, and the Git worktree;
2. installs dependencies and runs the bridge test suite;
3. writes the project mapping used by launch scripts;
4. generates Claude hooks with absolute paths and reviewer-home deny rules;
5. generates the dedicated Codex configuration and permission profiles.

Re-run setup after moving either folder. Review the generated Claude deny rules
if the bridge path contains unusual wildcard characters.

## 5. Authenticate the dedicated reviewer

```powershell
.\scripts\Initialize-Reviewer.ps1
```

Add `-DeviceAuth` when browser-based local login is unsuitable. Authentication
is stored in this ignored reviewer home rather than the application's normal
Codex home.

## 6. Start a workstream

```powershell
.\scripts\Start-Pair.ps1 -Feature 'billing-retry-policy'
```

Use a stable feature name for the life of one task. It is the lookup key for the
stored Claude session UUID and Codex thread UUID; matching terminal titles alone
do not route messages.

The normal flow is:

1. Submit the product or task brief in Claude.
2. Claude creates a plan, design, specification, or implementation handoff.
3. The Stop hook starts a read-only review in the persistent Codex thread.
4. Read the Codex review and use `$bridge-publish` or `$bridge-cancel`.
5. Continue until the workstream is complete; `manual` mode remains armed.

Use a new feature name and Codex thread for unrelated work.

During investigation, a structured Claude `AskUserQuestion` is mirrored into
the same Codex thread as a read-only advisory. Claude remains waiting in its own
question UI. Discuss or challenge Codex's recommendation there, then answer
Claude yourself. Do not use `$bridge-publish` for question advisories.

## 7. Validate the integration

Before relying on it, exercise all of these cases:

- Wait more than six minutes before publishing and confirm the Stop remains held.
- Publish unchanged feedback and confirm immediate `stop-hook` delivery.
- Publish an edited subset and confirm Claude receives the composed findings,
  not the editing instruction.
- Let Claude produce a newer Stop while an older review is pending and confirm
  latest-checkpoint-wins behavior.
- Restart after a disconnected Stop and confirm `next-prompt` recovery.
- Have Claude call `AskUserQuestion`; confirm Codex receives the structured
  choices while Claude stays waiting, then answer manually in Claude.
- Trigger a question while Codex is busy and confirm it starts after the active
  turn completes without polling.
- If applicable, run a frontend checkpoint and confirm Playwright can reach the
  application, authentication state, and required routes.
- Switch an interactive reviewer to `bridge-write` only after an explicit user
  implementation request, then switch back to `bridge-review`.

Inspect `runtime/bridge.log` and `$bridge-status` when routing is unclear.

## 8. Tailor tools without changing the bridge protocol

Add project-specific MCP servers to the generated Codex configuration or teach
setup to generate them. Keep protocol tools under the `review_bridge_*`
namespace. Application tools should use their own namespaces.

If the application requires Linux or macOS launchers, port the PowerShell
scripts while preserving these contracts:

- one persistent feature-to-session mapping;
- a private loopback endpoint with bearer authentication;
- fail-open Claude hooks when the broker is genuinely unavailable;
- checkpoint-bound publication;
- read-only injected reviews;
- heartbeat streaming while human approval is pending.

## 9. Prepare for distribution

Before sharing the bridge beyond a trusted team:

- select an explicit open-source or commercial license;
- add CI on every supported operating system and Node version;
- pin and routinely update dependencies;
- publish a threat model and responsible disclosure path;
- document compatibility with tested CLI versions;
- add release notes and a migration policy for persisted bridge state.
