---
name: bridge-force-publish
description: Explicitly queue an unheld interactive Codex review for Claude's next user prompt in manual or active auto mode, including after a skipped, deferred, or continued review.
---

Call `review_bridge_status` for the paired feature. Proceed only in `manual` or
active `auto` mode, with status `idle`, `passed`, or `waiting-claude`, no `pending`,
`queuedClaudeContext`, or `explicitClaudeMessage`, and a paired `codexThreadId`.
Standby and catch-up require resume first. This remains an explicit interactive
operation; injected reviews and question/pulled advisories cannot publish.

If a checkpoint is pending, direct the user to `$bridge-publish` or
`$bridge-cancel`; never bypass checkpoint binding. If feedback is already queued,
do not overwrite it. For an explicit queued message, report its ID and offer
`$bridge-discard-message` only if the user wants to remove it.

Select the most recent substantive Codex review in this conversation. Exclude
status messages, failed-publication notices, and commentary. Never use the
broker's possibly stale `lastCodexResponse`. If no substantive review is
identifiable, ask the user for exact feedback.

Treat additional text as an edit instruction by default and compose the final
review. Treat it as a replacement only after `send exactly`, `verbatim feedback`,
or `replace the review with`.

Call `review_bridge_force_publish` with the feature, exact `codexThreadId`, and
composed feedback. Confirm `delivery: next-prompt`: this unheld recovery appears
when the user submits Claude's next prompt. Report the message ID and explain
that newer checkpoints and broker restarts preserve it, standby pauses delivery,
and switching off discards it. Review mode, round count, and limits are unchanged.
