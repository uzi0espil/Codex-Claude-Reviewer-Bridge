---
name: bridge-auto
description: Arm the bounded automatic Claude-Codex review loop for the paired workstream. Use when the user explicitly requests automatic review and revision without approval after every round.
---

Call `review_bridge_set_mode` with the paired feature and mode `auto`.

Explain that injected Codex turns remain read-only and allow at most three
automatic revise rounds per cycle. Auto remains armed across successful cycles
and human publish/cancel decisions until `$bridge-off` is invoked.

Automatic reviews return normal Markdown. Their control decision is recorded
separately by the bridge. `needs_user`, a missing control decision, or the cycle
limit pauses the exact checkpoint for human review without changing modes. A
passing cycle displays its report to the user through Claude's Stop-hook UI; it
is not sent to Claude as feedback or added as a second Codex history item.
