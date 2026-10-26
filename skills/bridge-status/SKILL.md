---
name: bridge-status
description: Show pairing IDs, mode, pending checkpoint, captured off-mode handoff availability, question-advisory queue, queued feedback, and recovery state for a Claude-Codex bridge workstream. Use for routing checks, delivery diagnosis, or bridge status requests.
---

Include activity (active, standby, or catching-up), standby reason, backlog
prompt/handoff counts, journal bytes, any capture gap, and retry deadline when
returned by the tool. No deadline means manual resume is required. Never expose
stored message content. In standby, recommend `$bridge-resume` after capacity
returns or when the user wants automatic review again.

Call `review_bridge_status` with the paired feature and summarize the result.

Treat immutable Claude session and Codex thread IDs as routing; the shared name
is only a label. Report checkpoint sequence, ID, status, supersession, and queued
next-prompt delivery when present. For an interim checkpoint, report the
background-task count without reproducing task descriptions or commands.
Identify `lastForcedPublishAt` as an audited
forced recovery publication without reproducing held response content. Report
the active question advisory ID and queued advisory count without reproducing
the question content. For `capturedClaudeMessage`, report its ID, capture time,
session ID, and review/queue availability without reproducing the message. Report
an active or queued `pulledReview` by ID. If checkpoint history is relevant,
tell the user that `just report <feature>` prints the live report for every
checkpoint created during the current broker session without a model turn, and
that `--full` also reveals the stored Claude handoffs.
