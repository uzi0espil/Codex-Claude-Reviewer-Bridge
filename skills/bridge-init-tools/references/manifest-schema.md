# Review-tool manifest schema

The manifest is JSON with this top-level shape:

```json
{
  "schemaVersion": 1,
  "projectRoot": "<exact absolute bound application path>",
  "approvedAt": "<ISO-8601 timestamp>",
  "readinessDefaults": { "mode": "static" },
  "tools": []
}
```

Each tool needs a unique lowercase `id` matching
`^[a-z][a-z0-9_]{1,63}$`, a title, description, runner, optional typed inputs,
a timeout from 1 to 86400 seconds, MCP annotations, and repository evidence.
Existing manifests that omit `readinessDefaults` remain valid and default to
`static`.

## Readiness

The global readiness default is either:

- `static`: inspect host executables, repository paths, and Compose files
  without executing a runtime command. Container-backed tools normally report
  `needs_runtime_probe`.
- `trusted`: after structural checks pass, report runtime readiness as `ready`
  with basis `user_trusted`. This records an explicit user assumption; it is not
  runtime evidence.

A tool may override the default with `"readiness": { "mode": "static" }` or
`"readiness": { "mode": "trusted" }`. It may instead define an approved probe:

```json
{
  "readiness": {
    "mode": "probe",
    "runner": {
      "kind": "compose_exec",
      "files": ["compose.yml"],
      "service": "backend",
      "workdir": "/app",
      "command": "python",
      "args": ["--version"],
      "cwd": "."
    },
    "timeoutSeconds": 30,
    "cacheSeconds": 300
  }
}
```

Probe runners support `host`, `compose`, and `compose_exec`. They use fixed argv
execution and have no dynamic inputs. `review_tools_probe` runs only these
approved probes. Successful and failed results are cached in ignored reviewer
runtime state by manifest SHA-256 for the approved duration. The doctor reports
the readiness basis as `static`, `user_trusted`, or `runtime_probe`. Structural
failures always remain `missing`, regardless of readiness mode.

## Runner kinds

- `host`: fixed `command`, `args`, and repository-relative `cwd`.
- `compose`: fixed Compose `files`, Compose `args`, and
  repository-relative `cwd`.
- `compose_exec`: fixed Compose `files`, `service`, container `command`,
  `args`, optional container `workdir`, and repository-relative `cwd`.
  It uses `docker compose exec -T` and therefore requires a running service.
- `compose_stage_exec`: fixed Compose `files`, `service`,
  repository-relative `sourceDirectory`, absolute container `workdir`,
  container `command` and `args`, repository-relative `cwd`, and optional
  artifact templates. It creates a unique scratch directory, copies only the
  approved source subtree into it, executes there, retrieves declared artifacts
  into the reviewer's ignored runtime directory, and attempts cleanup.

Every runner may include a fixed `environment` object, but never store tokens,
passwords, credentials, private keys, or secret-like variables. Prefer inheriting
the approved runtime environment.

## Typed inputs

Inputs have a lowercase `name`, description, type, and optional `required`,
`flag`, or `valueTemplate`.

- `string`: optional default, regex pattern, and maximum length.
- `enum`: fixed allowed values and optional default.
- `integer`: optional default, minimum, and maximum.
- `boolean`: requires a fixed flag.
- `repo_paths`: bounded paths validated to remain inside the bound repository.
- `strings`: bounded raw argv entries; use only after specific approval.

Inputs append argv entries; they never invoke a shell. A `valueTemplate` such
as `--tail={value}` or `{stage}/report.json` places the validated value in one
argv entry. For staged tools, `{stage}` is the unique container scratch path.

## Annotations and evidence

Set all four annotations explicitly:

```json
{
  "readOnlyHint": false,
  "destructiveHint": false,
  "idempotentHint": true,
  "openWorldHint": false
}
```

Annotations describe behavior; they do not grant permission. Mark commands that
write caches, coverage, build output, snapshots, databases, or container state as
not read-only. Mark truly stateful or cleanup-like operations accurately.

The `evidence` array should cite repository-relative files and, when useful,
keys or targets such as `package.json#scripts.test` or
`.github/workflows/ci.yml`.
