---
name: bridge-force-publish
description: Force-publish an unheld interactive Codex review to Claude's next prompt. Use only for explicit recovery after a restart, cancelled checkpoint, disconnected Stop hook, or manually pasted Claude handoff left the bridge idle.
---

Call `review_bridge_status` for the paired feature. Proceed only when mode is
`manual`, status is `idle`, `pending` and `queuedClaudeContext` are absent, and
`codexThreadId` is present.

If a checkpoint is pending, direct the user to `$bridge-publish` or
`$bridge-cancel`; never bypass checkpoint binding. If feedback is already queued,
do not overwrite it.

Select the most recent substantive Codex review in this conversation. Exclude
status messages, failed-publication notices, and commentary. Never use the
broker's possibly stale `lastCodexResponse`. If no substantive review is
identifiable, ask the user for exact feedback.

Treat additional text as an edit instruction by default and compose the final
review. Treat it as a replacement only after `send exactly`, `verbatim feedback`,
or `replace the review with`.

Call `review_bridge_force_publish` with the feature, exact `codexThreadId`, and
composed feedback. Confirm `delivery: next-prompt`: this unheld recovery appears
when the user submits Claude's next prompt, and manual mode remains armed.
