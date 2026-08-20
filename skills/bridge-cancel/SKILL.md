---
name: bridge-cancel
description: Cancel the latest pending bridge checkpoint and let Claude finish without Codex feedback. Use when the user rejects or does not want to publish the current review.
---

First call `review_bridge_status` with the paired feature. Then call
`review_bridge_cancel` with the exact latest `pending.id` as `checkpointId`.

If no checkpoint is pending, say so. If the ID was superseded, fetch status
again instead of cancelling another checkpoint silently. Confirm release and
report the returned mode accurately: `manual` remains armed, while `once` and
`auto` return to `off`.
