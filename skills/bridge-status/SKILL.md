---
name: bridge-status
description: Show pairing IDs, mode, pending checkpoint, question-advisory queue, queued feedback, and recovery state for a Claude-Codex bridge workstream. Use for routing checks, delivery diagnosis, or bridge status requests.
---

Call `review_bridge_status` with the paired feature and summarize the result.

Treat immutable Claude session and Codex thread IDs as routing; the shared name
is only a label. Report checkpoint sequence, ID, status, supersession, and queued
next-prompt delivery when present. Identify `lastForcedPublishAt` as an audited
forced recovery publication without reproducing held response content. Report
the active question advisory ID and queued advisory count without reproducing
the question content.
