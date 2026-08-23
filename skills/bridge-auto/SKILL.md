---
name: bridge-auto
description: Arm the bounded automatic Claude-Codex review loop for the paired workstream. Use when the user explicitly requests automatic review and revision without approval after every round.
---

Call `review_bridge_set_mode` with the paired feature and mode `auto`.

Explain that injected Codex turns remain read-only and allow at most three
unattended feedback or continuation rounds per cycle. Auto remains armed across
successful cycles and human publish/cancel decisions until `$bridge-off` is
invoked.

Automatic reviews return normal Markdown. Their control decision is recorded
separately by the bridge. A final `pass` lets Claude stop. `pass_continue` is
valid only when the current gate passes and a concrete next action was already
authorized by the user; supply only that action as the continuation. Never use
it to infer permission, expand scope, or authorize an external mutation. Use
`needs_user` when authorization is unclear.

`pass_continue` sends Claude only the scoped continuation and consumes one of
the three unattended rounds. The user-facing cycle report is not sent as Claude
feedback or added as a second Codex history item. `needs_user`, a missing
control field, or the cycle limit pauses the exact checkpoint for human review
without changing modes. The complete report is also saved outside both model
histories; tell the user to run `just report <feature>` if needed.
