---
name: bridge-pull-review
description: Pull the latest Claude assistant handoff captured while the bridge was off into a one-off read-only Codex advisory for the user. Use when the user wants a second opinion without arming the bridge or sending feedback to Claude.
---

Call `review_bridge_status` for the paired feature, then call
`review_bridge_pull_review` with that feature. This command is valid in every
bridge mode, including off, but requires a captured off-mode Claude handoff.

Confirm that the advisory is starting or queued in the same Codex thread and
that the current bridge mode is unchanged. The resulting review is for the user
only: do not publish it, record an automatic decision, or represent it as queued
feedback for Claude. Repeating this command for the same captured handoff is
rejected, but `$bridge-pull-queue` may still process that handoff once.
