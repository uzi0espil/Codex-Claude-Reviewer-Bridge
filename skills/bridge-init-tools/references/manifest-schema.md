# Review-tool manifest schema

The manifest is JSON with this top-level shape:

```json
{
  "schemaVersion": 1,
  "projectRoot": "<exact absolute bound application path>",
  "approvedAt": "<ISO-8601 timestamp>",
  "tools": []
}
```

Each tool needs a unique lowercase `id` matching
`^[a-z][a-z0-9_]{1,63}$`, a title, description, runner, optional typed inputs,
a timeout from 1 to 86400 seconds, MCP annotations, and repository evidence.

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

