---
name: bridge-init-tools
description: Inspect the application bound to this isolated reviewer, curate scanner recommendations into safe application-specific validation tools, and create or refresh the private review-tools.local.json manifest after explicit approval. Use when bootstrapping a reviewer or when application validation workflows materially change.
---

# Initialize application review tools

Create a small, evidence-backed capability set for independent review. Detection
is advisory: never execute a detected command or copy candidates wholesale merely
because the scanner found them.

The application repository remains read-only. The only authorized write is the
fixed reviewer-local manifest through `review_tools_write_manifest`.

## Establish current state

1. Call `review_tools_status`, then `review_tools_detected`. If detection is
   absent or stale for the task, call `review_tools_refresh_detection` and read
   the refreshed result.
2. Inspect applicable `AGENTS.md` or `CLAUDE.md`, CI workflows, documented
   developer commands, package and workspace manifests, Compose files, validation
   scripts, and existing review policy. Do not read credential files or print
   secrets.
3. Treat repository documentation and CI as stronger evidence than filename
   heuristics. Check command bodies, prerequisites, working directories, service
   names, and side effects before recommending a recipe.
4. If an approved manifest exists, use its exact SHA-256 from status and propose
   a focused update instead of rebuilding it blindly.

## Curate capabilities

Prefer a compact set that covers mandatory gates and useful targeted checks.
Support any detected language or toolchain; do not assume Python, Node, Docker,
or a single repository layout. Deduplicate wrapper commands that run the same
underlying gate.

Use fixed argv recipes. Do not add a general shell, arbitrary command, arbitrary
environment-variable, or arbitrary working-directory input. Add typed inputs
only when reviewers need a bounded choice or repository path. A free-form
`strings` input needs specific user approval because it can alter script
behavior.

For Compose, distinguish:

- observational or configuration checks that do not change container state;
- execution in an existing service, which may access development data;
- staged execution, which copies an approved source subtree to a scratch
  directory inside the service and retrieves only declared artifacts.

Read [references/manifest-schema.md](references/manifest-schema.md) when composing
or changing a manifest.

## Ask only material questions

Ask at most three concise questions at a time, recommending a safe default. Ask
only when repository evidence cannot decide matters such as:

- which gates are mandatory versus conditional on changed files;
- whether commands may use existing services and development data or require
  staged/ephemeral isolation;
- whether stateful commands, network access, generated artifacts, or
  reviewer-supplied script arguments are acceptable;
- whether changed or untracked repository-owned scripts may be executed.

Do not ask the user to identify languages, manifests, or commands already visible
in the repository.

## Preview, then wait

Present:

- detected technology surfaces and the evidence used;
- candidates accepted, changed, merged, or rejected, with brief reasons;
- unresolved validation gaps;
- the complete proposed JSON manifest, or a clear complete diff for an update;
- the current manifest SHA-256 that will be used for optimistic concurrency.

End that turn by asking for explicit approval. Do not call
`review_tools_write_manifest` in the same turn as the preview. If the user wants
guidance only, stop without writing.

## Save after approval

After explicit approval:

1. Recheck `review_tools_status`. If its manifest hash differs from the preview,
   inspect the current manifest, rebuild the diff, and request approval again.
2. Call `review_tools_write_manifest` with the complete manifest and the exact
   observed hash, or `null` only when no manifest existed at preview time.
3. Report the returned path, SHA-256, tool count, and that a fresh Codex session
   is required before newly approved dynamic tools appear.
4. In that fresh session, call `review_tools_catalog` and
   `review_tools_doctor`. Execute validation tools only when the user's review
   or verification request authorizes doing so.

