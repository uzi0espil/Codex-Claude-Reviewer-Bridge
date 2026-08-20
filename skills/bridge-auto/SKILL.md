---
name: bridge-auto
description: Arm the bounded automatic Claude-Codex review loop for the paired workstream. Use when the user explicitly requests automatic review and revision without approval after every round.
---

Call `review_bridge_set_mode` with the paired feature and mode `auto`.

Explain that injected Codex turns remain read-only and allow at most three
automatic revise cycles. `needs_user`, invalid structured output, or the cycle
limit pauses for human review.
