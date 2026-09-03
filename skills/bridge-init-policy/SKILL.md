---
name: bridge-init-policy
description: Inspect the application bound to this isolated reviewer instance, ask only for material review choices that cannot be derived, and create or refresh its private review-policy.local.md overlay. Use when bootstrapping a new reviewer instance, when the user invokes $bridge-init-policy, or when application architecture, validation requirements, or review priorities have materially changed.
---

# Initialize the review policy

Build a stable application-level review rubric. Do not review a current feature or
encode conclusions about one implementation into the policy.

## Inspect first

- Read the generic policy at `$CODEX_HOME/review-policy.md` and any existing
  `$CODEX_HOME/review-policy.local.md`.
- Read the target repository's applicable `AGENTS.md`, `CLAUDE.md`, project-owned
  skills, architecture decisions, specifications, CI configuration, manifests,
  test commands, migrations, and frontend entrypoints.
- Infer artifact locations, architectural boundaries, validation commands, and
  browser requirements from repository evidence. Cite the paths used when
  explaining the draft.
- Use live web research only when a current external fact materially affects the
  durable review procedure. Prefer primary sources.
- Never read or record credentials, tokens, production secrets, or test-account
  passwords in the policy.

## Preserve existing policy text faithfully

Read the generic and local policy files from their exact bytes using strict
UTF-8 decoding. A terminal, tool renderer, or transcript may display valid
Unicode as mojibake or replacement text. Before claiming that stored text is
corrupted, re-read the file with an explicit UTF-8 decoder and verify the exact
decoded characters or code points.

Valid Unicode punctuation and symbols, including curly quotes, arrows, and
multiplication signs, are not corruption. Do not normalize them to ASCII or
propose any other semantically neutral typography rewrite unless the user asks
for that style change or repository policy requires it. If strict decoding
really fails, describe the byte-level evidence and limit the proposed repair to
the affected text.

## Preserve validation fidelity

Before drafting validation requirements, build a private inventory of
repository-established checks from CI jobs, path filters, documented developer
commands, manifests, and task runners. For each relevant check, record:

- the changed files, risks, or workflow conditions that trigger it;
- dependency installation and other setup steps;
- the exact working directory;
- required services, environment, fixtures, credentials, or hardware;
- the exact command and fixed arguments, including exclusions and selectors;
- whether it is mandatory, conditional, destructive, expensive, or CI-only.

Treat prerequisites, working directories, exclusions, and ordering as part of
the validation procedure. Do not shorten or generalize a command in a way that
changes its scope. Distinguish unconditional gates from path-filtered checks and
ordinary local commands.

Before previewing the policy, reconcile every stated validation requirement
against this inventory and cite its repository evidence. If an approved review
tool manifest exists, compare its catalog with the required checks and identify
missing capabilities. If no manifest exists, distinguish evidence the policy
requires from commands the reviewer is currently authorized to execute. Do not
turn an approximate command list into policy; defer exact executable recipes to
`$bridge-init-tools`.

Report point-in-time manifest coverage only in the surrounding session response,
outside the proposed policy Markdown. Never copy the current tool inventory,
manifest hash, readiness states, accepted gaps, or missing-capability list into
the durable overlay. Those facts change independently of the review policy and
must be read dynamically from the currently approved manifest. The overlay may
state the durable rule that application commands require an approved capability
and that an absent capability is a validation gap.

## Stay within the policy workflow

Policy initialization defines review requirements; it does not curate executable
tools. You may inspect the existing approved manifest as read-only evidence, but
never refresh tool detection, build or validate a tool proposal, choose runners
or readiness, accept validation gaps, call any `review_tools_*` tool, or ask the
user to approve changes to `review-tools.local.json` in this workflow.

If the approved manifest is absent, stale, or missing a required capability,
state the exact gap in the explanatory session response, not in the proposed
policy text, and direct the user to run `just tools` after the policy workflow
finishes. Continue drafting the policy independently; do not switch to
`$bridge-init-tools` unless the user starts a separate tools session.

## Ask only unresolved questions

Ask concise questions only when the answer changes the rubric and cannot be
derived safely. Group at most three questions at a time and recommend a default.
Typical unresolved choices are:

- risk areas that deserve unusually strict review;
- mandatory evidence beyond commands already documented in the repository;
- supported browser environments or manually provisioned test states;
- conditions that must return `needs_user` in automatic mode.

Do not interview the user about discoverable paths, frameworks, or commands. If
the user prefers guidance only, produce the draft and stop before writing.

## Draft the overlay

Keep the Markdown concise and application-specific. Do not repeat the generic
baseline. Use these sections, omitting only genuinely inapplicable material:

1. `# <Application> review policy`
2. `## Context and artifact routing`
3. `## Review stages and evidence`
4. `## Priority risks and architectural boundaries`
5. `## Validation commands`
6. `## Frontend and browser validation`
7. `## External research`
8. `## Findings, severity, and automatic-mode escalation`

Distinguish requirements established by repository evidence from user-selected
preferences. Include a command only with its verified invocation context; when
the durable rule is about evidence rather than invocation, name the required
capability and cite its authoritative CI job or documentation instead. For
frontend applications, describe routes, states, breakpoints, themes,
console/accessibility checks, and what to report when the application cannot be
exercised. For non-frontend applications, state that browser validation is not
normally required instead of inventing it.

## Preview and save

Before requesting approval, compare the fully composed policy's exact UTF-8
bytes with the existing overlay. If they are identical, or the proposed diff is
otherwise empty, report that no durable policy change is needed and end the
workflow successfully. Do not ask for approval, call the policy writer, or
re-save an unchanged file merely to refresh it.

Before writing, show the complete first draft or a clear diff against the current
overlay. Explain uncertain or user-selected rules. End that turn by asking for
explicit approval only when the proposed file content changes; do not call the
write tool in the same turn as the preview.

After approval:

1. If the overlay exists, read it as UTF-8 and compute the SHA-256 of its exact
   bytes. Otherwise use `null` as `expectedSha256`.
2. Call `review_bridge_write_policy` with the fully composed Markdown and the
   observed hash. Never pass editing instructions in place of the policy.
3. If the hash check fails, re-read the overlay, rebuild and preview the diff,
   and ask for approval again.
4. Report the returned path, hash, and whether the file was created or updated.

The application repository remains read-only throughout this workflow. The only
authorized write is the exact local policy file through the bridge tool.
