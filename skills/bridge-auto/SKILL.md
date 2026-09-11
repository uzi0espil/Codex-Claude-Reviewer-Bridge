---
name: bridge-auto
description: Arm the automatic Claude-Codex review loop, optionally with a per-cycle round limit. Use when the user explicitly requests automatic review and revision without approval after every round.
---

Accept zero or one argument:

- With no argument, call `review_bridge_set_mode` with the paired feature and
  mode `auto`, omitting `roundLimit`. This allows unlimited unattended rounds.
- With one positive integer argument, include it as `roundLimit`. This bounds
  unattended feedback or continuation deliveries per cycle.
- For any other argument, explain that the command accepts only one positive
  integer and do not change the mode.

Explain whether the configured mode is unlimited or bounded. Injected Codex
turns remain read-only. Auto remains armed across successful cycles and human
publish/cancel decisions until `$bridge-off` is invoked. A final pass or a human
publish/cancel decision resets the per-cycle unattended counter.

Automatic reviews return normal Markdown. Their control decision is recorded
separately by the bridge. A final `pass` lets Claude stop. `pass_continue` is
valid only when the current gate passes and a concrete next action was already
authorized by the user; supply only that action as the continuation. Never use
it to infer permission, expand scope, or authorize an external mutation. Use
`needs_user` when authorization is unclear.

When a checkpoint is marked interim because Claude still has background work
in flight, review any completed parallel work that is already assessable. Use
`revise` for actionable material findings or `needs_user` for a required
decision. Otherwise call `review_bridge_defer_checkpoint`; do not send Claude a
message whose only instruction is to keep waiting. Deferral leaves auto armed
and does not consume or reset the unattended counter.

`pass_continue` sends Claude only the scoped continuation and consumes one
unattended round. The user-facing cycle report is not sent as Claude feedback or
added as a second Codex history item. `needs_user`, a missing control field, or
an exhausted configured limit pauses the exact checkpoint for human review
without changing modes. Every round is saved outside both model histories;
`just report <feature>` deterministically assembles every response since the
previous final pass, even when a human decision reset the unattended counter,
without invoking either model.
