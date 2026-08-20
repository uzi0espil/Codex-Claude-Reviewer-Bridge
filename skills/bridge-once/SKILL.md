---
name: bridge-once
description: Arm one read-only Codex review of Claude's next completed response in the paired workstream. Use when the user asks for a single review checkpoint or bridge-once mode.
---

Call `review_bridge_set_mode` with the paired feature and mode `once`. Use the
feature name from bridge metadata. If it is unclear, ask rather than guessing.

Report that Claude's next Stop will wait for this Codex thread and that
`$bridge-publish` or `$bridge-cancel` releases it. After that decision, once mode
returns to `off`.
