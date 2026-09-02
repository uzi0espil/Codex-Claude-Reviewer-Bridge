---
name: bridge-init-tools
description: Inspect the application bound to this isolated reviewer, curate scanner recommendations into safe application-specific validation tools, and create or refresh the private review-tools.local.json manifest after explicit approval. Use when bootstrapping a reviewer or when application validation workflows materially change.
---

# Initialize application review tools

Create a complete, evidence-backed capability set for independent review. Detection
is advisory: never execute a detected command or copy candidates wholesale merely
because the scanner found them.

The application repository remains read-only. The only authorized write is the
fixed reviewer-local manifest through `review_tools_write_manifest`.

## Establish current state

1. Call `review_tools_status`, then `review_tools_detected`. Record the exact
   detection SHA-256. If detection is absent or stale for the task, call
   `review_tools_refresh_detection` and read the refreshed result.
2. Inspect applicable `AGENTS.md` or `CLAUDE.md`, CI workflows, documented
   developer commands, package and workspace manifests, Compose files, validation
   scripts, and existing review policy. Do not read credential files or print
   secrets.
3. Treat repository documentation and CI as stronger evidence than filename
   heuristics. Check command bodies, prerequisites, working directories, service
   names, and side effects before recommending a recipe.
4. If an approved manifest exists, use its exact SHA-256 from status and propose
   a focused update instead of rebuilding it blindly.

Build a private validation inventory before curating recipes. Start with every
detected CI step whose role is `validation`; use detected `support` steps as setup
and prerequisite evidence rather than independent gates. Then add requirements
established by policy, repository documentation, package manifests, and task
runners. For each relevant CI or documented check, preserve its trigger or path
filter, setup, working directory, required services and environment, exact fixed
arguments and exclusions, ordering constraints, and whether it is conditional
or CI-only.
Record the runner kinds that can genuinely produce that evidence; an
observational Compose command cannot satisfy a test or migration requirement.
Reconcile this inventory with the current review policy: every inventory
requirement must map exactly once to one or more approved capabilities or an
explicit validation gap. Never omit a difficult, expensive, stateful, CI-only,
or service-backed requirement from the inventory. A gap is a visible user choice,
not a shortcut for recipe design.
Do not simplify a command in a way that broadens or narrows the evidence it
produces.

## Curate capabilities

Only after coverage is complete, prefer a compact set that deduplicates genuinely
equivalent execution routes. Sharing a container does not make different checks
equivalent: lint, tests, migrations, and backup validation remain distinct
capabilities unless a repository-owned wrapper deliberately runs them together.
Support any detected language or toolchain; do not assume Python, Node, Docker,
or a single repository layout. Deduplicate wrapper commands that run the same
underlying gate.

Use fixed argv recipes. Do not add a general shell, arbitrary command, arbitrary
environment-variable, or arbitrary working-directory input. Add typed inputs
only when reviewers need a bounded choice or repository path. A free-form
`strings` input needs specific user approval because it can alter script
behavior.

Choose execution policy separately from readiness. Ask which runner kinds the
user permits and record all four choices in `runnerPolicy`: host commands,
observational Compose commands, execution in existing Compose services, and
staged Compose execution. For Compose, distinguish:

- observational or configuration checks that do not change container state;
- execution in an existing service, which may access development data;
- staged execution, which copies an approved source subtree to a scratch
  directory inside the service and retrieves only declared artifacts.

Only after runner policy is settled, choose readiness behavior with the user
instead of treating one runtime policy as universal. Recommend the global
`static` default, which reports container
commands as `needs_runtime_probe` without executing anything. Offer global
`trusted` readiness when the user explicitly accepts runtime prerequisites.
Allow individual tools to override either default with `static`, `trusted`, or a
fixed `probe`. A probe must be bounded, non-destructive, evidence-backed, and
approved as part of the manifest. It may check service state, an executable,
mounted paths, dependencies, or another prerequisite the user considers
material. Never let trusted or probed readiness hide a structural manifest,
path, Compose-file, or host-executable failure.

Read [references/manifest-schema.md](references/manifest-schema.md) when composing
or changing a manifest.

## Ask only material questions

Ask at most three concise questions at a time, recommending a safe default. Never
combine runner authorization with readiness behavior; they are independent
decisions. Ask only when repository evidence cannot decide matters such as:

- which gates are mandatory versus conditional on changed files;
- whether commands may use existing services and development data or require
  staged/ephemeral isolation;
- whether stateful commands, network access, generated artifacts, or
  reviewer-supplied script arguments are acceptable;
- whether changed or untracked repository-owned scripts may be executed.
- whether runtime readiness should remain static, be explicitly trusted, or use
  approved probes, including any per-tool exceptions.

Do not ask the user to identify languages, manifests, or commands already visible
in the repository.

## Preview, then wait

Before presenting the approval preview, call `review_tools_validate_manifest`
with the complete version-2 proposal. Validation gaps must have `accepted: false`
at this stage. Resolve every structural, detection-revision, runner-policy,
coverage, path, executable, Compose-service, and command-shape error. Explain
warnings rather than silently discarding affected requirements. This validation
must not execute an application command.

Present:

- detected technology surfaces and the evidence used;
- candidates accepted, changed, merged, or rejected, with brief reasons;
- every structured requirement, including its detected CI ids, mapped to proposed
  tools or an explicit pending gap;
- the independent runner policy and why each chosen runner matches its execution
  environment;
- the proposed readiness default, per-tool overrides, probe commands, cache
  durations, and whether each ready state will be static, trusted, or probed;
- unresolved validation gaps;
- the complete proposed JSON proposal, without `approvedAt`, or a clear complete
  diff for an update;
- the preflight result, including command previews, warnings, coverage counts,
  and pending gaps;
- the current manifest SHA-256 that will be used for optimistic concurrency.

End that turn by asking for explicit approval. Do not call
`review_tools_write_manifest` in the same turn as the preview. If the user wants
guidance only, stop without writing.

## Save after approval

After explicit approval:

1. Recheck `review_tools_status`. If its manifest hash differs from the preview,
   inspect the current manifest, rebuild the diff, and request approval again.
2. Change only the previewed gaps from `accepted: false` to `accepted: true`, then
   call `review_tools_validate_manifest` again. If it is not writable, stop and
   correct or re-approve the proposal.
3. Call `review_tools_write_manifest` with the complete version-2 proposal and
   the exact observed hash, or `null` only when no manifest existed at preview time.
   The writer supplies the actual `approvedAt` timestamp; never invent it.
4. Report the returned path, SHA-256, requirement count, accepted-gap count,
   tool count, approval time, and that a fresh Codex session is required before
   newly approved dynamic tools appear.
5. In that fresh session, call `review_tools_catalog` and
   `review_tools_doctor`. If the approved manifest contains probes, call
   `review_tools_probe` only when the user selected or requests runtime probing,
   then call the doctor again. Execute validation tools only when the user's
   review or verification request authorizes doing so.
