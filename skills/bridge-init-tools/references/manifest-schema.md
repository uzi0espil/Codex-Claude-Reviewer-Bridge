# Review-tool manifest schema

New proposals use schema version 2. They omit `approvedAt`; the path-fixed writer
adds the actual approval time when it stores the manifest:

```json
{
  "schemaVersion": 2,
  "projectRoot": "<exact absolute bound application path>",
  "detectionSha256": "<exact current review-tools.detected.json SHA-256>",
  "runnerPolicy": {
    "host": "allowed",
    "compose": "allowed",
    "composeExec": "allowed",
    "composeStageExec": "disallowed"
  },
  "readinessDefaults": { "mode": "static" },
  "requirements": [],
  "coverage": [],
  "tools": []
}
```

Version-1 manifests remain readable, but every new or updated write must be a
complete version-2 proposal.

## Validation inventory and coverage

Each requirement needs a unique lowercase `id`, title, description,
`requiredWhen`, one or more procedure statements, prerequisites, repository
evidence, and any ids inherited from the current detected CI inventory:

```json
{
  "id": "backend_tests",
  "title": "Backend tests",
  "description": "Run the CI-equivalent backend test suite.",
  "requiredWhen": "Backend paths trigger the backend-test CI job.",
  "procedure": ["Preserve CI services, environment, exclusions, and cwd."],
  "prerequisites": ["PostgreSQL and object storage are available."],
  "allowedRunners": ["compose_exec"],
  "evidence": [".github/workflows/ci.yml#jobs.backend-test"],
  "detectedRequirementIds": ["ci_ci_yml_backend_test_run_tests"]
}
```

Every requirement has exactly one coverage disposition. A tool disposition may
reference several tools when the requirement is intentionally split:

```json
{ "requirementId": "backend_tests", "disposition": "tool", "toolIds": ["backend_tests"] }
```

A gap remains pending in the approval preview:

```json
{ "requirementId": "cuda_image_smoke", "disposition": "gap", "reason": "CI-only 10 GB GPU image build.", "accepted": false }
```

Detected CI entries have a `role`: every `validation` entry must be represented
by `detectedRequirementIds`; `support` entries supply setup and prerequisite
evidence and may be referenced without receiving their own coverage disposition.

After the user explicitly approves that preview, only `accepted` changes to
`true`. The writer rejects missing dispositions, stale or omitted detected CI
requirements, unknown tool references, and pending gaps.

## Runner policy

`runnerPolicy` independently allows or disallows `host`, `compose`,
`composeExec`, and `composeStageExec`. A Compose exec permission means commands
may enter an existing service and may observe its development environment and
data. Readiness settings do not grant a runner kind and runner policy does not
claim that runtime prerequisites are healthy.

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
  It may restrict `allowedPrefixes`, filename `extensions`, and `pathKind`
  (`any`, `file`, or `directory`). Use `maxItems: 1` for CLIs that accept one
  path after a flag.
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

## Preflight

Call `review_tools_validate_manifest` before asking for approval and again after
accepted gaps are toggled. It does not execute application commands. It verifies
the detection revision, coverage, runner policy, paths, host executables,
Compose files and statically declared services, readiness structure, path-input
scope, and logical argv previews. The second result must report `writable: true`
before `review_tools_write_manifest` is called.
