# Bootstrap an application

The public repository is a factory; a generated reviewer instance belongs to one
application for its entire lifetime. Create another instance for every unrelated
repository so Codex memories, sessions, skills, policy, and runtime state cannot
mix across applications.

## 1. Create the isolated instance

Keep a reusable checkout of the public template, then run:

```powershell
.\scripts\powershell\reviewer.ps1 create `
  --project-root 'C:\dev\YourApp' `
  --destination 'C:\dev\YourApp-reviewer' `
  --project-name 'Your App'
```

On Linux or macOS:

```bash
./scripts/shell/reviewer.sh create \
  --project-root /home/me/dev/YourApp \
  --destination /home/me/dev/YourApp-reviewer \
  --project-name 'Your App'
```

Omit `-Destination` to create `<application>-reviewer` beside the application.
Use `-SkipPlaywright` for an application that does not need browser review and
`-DeviceAuth` when local browser login is unsuitable. `-TemplateRepository` can
select a trusted private fork instead of the factory checkout's `origin`.

The factory rejects a reviewer destination inside the application, a non-empty
destination, a target that is not a Git repository, and a default factory
checkout that is dirty or not synchronized with its upstream. It also validates
the cloned workflow before setup or login, preventing a newer local factory
script from silently generating an older instance. If a later step fails, it
leaves the clone in place and reports the exact recovery script; it does not
delete partially initialized state.

For manual recovery inside an existing clone, run:

```powershell
.\scripts\powershell\reviewer.ps1 setup --project-root 'C:\dev\YourApp'
.\scripts\powershell\reviewer.ps1 login
```

```bash
./scripts/shell/reviewer.sh setup --project-root /home/me/dev/YourApp
./scripts/shell/reviewer.sh login
```

Setup is idempotent for the bound application but rejects a different project
root. A reviewer instance cannot be repurposed.

## 2. Generate the private policy

The factory starts the policy workflow after authentication. Resume it anytime:

```powershell
.\scripts\powershell\reviewer.ps1 policy
```

```bash
./scripts/shell/reviewer.sh policy
```

`$bridge-init-policy` first inspects repository guidance, project skills,
architecture decisions, specifications, CI, manifests, tests, migrations, and
frontend structure. It asks only about durable choices that cannot be inferred.
It then previews a complete initial policy or update diff and waits for explicit
approval.

The approved overlay is written to ignored `review-policy.local.md` through one
path-fixed MCP tool with optimistic hash checking. The application worktree stays
read-only. Never include secrets, passwords, production credentials, or findings
about one transient feature in the policy.

If the workflow is skipped, `start-pair` warns and reviews with the generic
tracked policy until initialization is completed.

## 3. Start and use a pair

From the generated instance:

```powershell
.\scripts\powershell\reviewer.ps1 start-pair --feature 'billing-retry-policy'
```

```bash
./scripts/shell/reviewer.sh start-pair --feature billing-retry-policy
```

The Unix launcher detects Terminal on macOS and common Linux terminal emulators.
If none is available, it prints separate `start-coder` and `start-reviewer`
commands. Force that portable fallback with `--terminal print`. WSL follows this
Linux behavior but is not an explicit terminal-launch compatibility target.

Arguments following `--` are passed unchanged to Claude. PowerShell users use
`--passthrough` for the same purpose because PowerShell consumes a literal `--`
before a script receives it. The corresponding `start-reviewer` and `policy`
commands pass their trailing arguments to Codex.

Use one stable feature name for one task. It selects immutable Claude and Codex
session UUIDs; matching terminal titles do not route messages. Use a new feature
name for unrelated work inside the same application.

The normal loop is:

1. Submit the product or task brief in Claude.
2. Claude produces a design, specification, implementation, or verification handoff.
3. The Stop hook starts a read-only review in the persistent Codex thread.
4. Inspect the review and invoke `$bridge-publish` or `$bridge-cancel`.
5. Continue until the workstream is complete; manual mode remains armed.

Claude `AskUserQuestion` calls are mirrored as read-only Codex advisories. Discuss
the recommendation in Codex, then answer personally in Claude. Advisories are
not publishable checkpoints.

## 4. Validate a new instance

Exercise these cases before relying on it:

- Confirm `bridge.local.json` contains the intended canonical project root and a
  unique instance ID.
- Confirm `review-policy.local.md` appears only in the sibling reviewer and is
  ignored by Git.
- Attempt setup with a second repository and confirm immutable binding rejects it.
- Wait more than six minutes before publishing and confirm the Stop remains held.
- Publish an edited subset and confirm Claude receives composed findings rather
  than editing instructions.
- Let Claude finish again during a pending review and confirm the latest checkpoint wins.
- Restart after a disconnected Stop and confirm next-prompt recovery.
- Trigger `AskUserQuestion` while Codex is idle and busy; confirm Claude still
  waits for the user's own answer.
- For frontend work, confirm Playwright can reach required routes and states.
- Request implementation explicitly, confirm `bridge-write` is used only for that
  work, and return to `bridge-review` afterward.

Use `runtime/bridge.log` and `$bridge-status` when routing is unclear.

## 5. Update without mixing state

Run:

```powershell
.\scripts\powershell\reviewer.ps1 update
```

```bash
./scripts/shell/reviewer.sh update
```

The updater requires a clean tracked reviewer worktree, fetches `origin`,
gracefully stops the broker, and performs only a fast-forward merge. It then reruns setup and validation for the
same immutable application mapping. Ignored policy, Codex home state, credentials,
sessions, feature mappings, and logs remain untouched.

If tracked files were customized, commit or resolve them before updating. The
updater never runs `reset`, deletes the instance, or silently resolves conflicts.

## 6. Distribution boundaries

- Keep application names and policy out of the public template runtime.
- Keep generated integration files, auth, state databases, runtime, and the local
  policy ignored.
- Add application-specific MCP servers only to that application's setup flow.
- Keep protocol tools under `review_bridge_*`; use separate namespaces for
application tools.
- Keep platform-specific wrappers thin; orchestration belongs in
  `scripts/reviewer.mjs` so PowerShell and Bash retain identical behavior.
