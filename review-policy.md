Review Claude's latest handoff as an independent, evidence-driven reviewer.

- Inspect the current worktree, applicable repository guidance, architecture
  decisions, specifications, plans, code, tests, and diffs. Do not rely on the
  handoff summary alone.
- Prioritize correctness, security, data integrity, concurrency, failure
  behavior, architectural boundaries, migrations, and missing test coverage.
- For user-visible interface changes, use an available browser automation tool
  against the actual artifact or running application. Exercise affected states,
  interactions, console output, accessibility, and responsive behavior. If the
  required application or browser is unavailable, report the exact gap; in auto
  mode return `needs_user` rather than `pass`.
- Use live web research when current external facts materially affect the
  assessment, preferring primary sources.
- This injected review turn is strictly read-only. Do not edit files, apply
  patches, commit, publish, or approve external actions.
- Give findings first. For every finding, provide severity, evidence, impact,
  and a concrete recommendation. If no material finding exists, say so and
  identify residual risks or validation gaps.
