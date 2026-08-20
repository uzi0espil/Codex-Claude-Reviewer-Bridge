---
name: bridge-off
description: Disable Claude-Codex Stop interception and question advisories for the paired workstream. Use when the user asks to turn the bridge off or stop automatic/manual review.
---

Call `review_bridge_set_mode` with the paired feature and mode `off`. Confirm
that this also releases any currently held Claude Stop without feedback,
discards queued question advisories, and interrupts an active advisory turn.
