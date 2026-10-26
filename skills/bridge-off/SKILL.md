---
name: bridge-off
description: Disable Claude-Codex Stop interception and question advisories for the paired workstream. Use when the user asks to turn the bridge off or stop automatic/manual review.
---

Off also cancels automatic recovery timers. It retains an unfinished standby
backlog, but captures only the latest off-mode handoff. For a temporary break
with complete supported hook capture, use `$bridge-standby` instead. Re-arming
auto with unfinished recovery requires `$bridge-resume`.

Call `review_bridge_set_mode` with the paired feature and mode `off`. Confirm
that this also releases any currently held Claude Stop without feedback,
discards queued question advisories, and interrupts an active question advisory
turn. Explain that subsequent completed assistant handoffs are still captured
one at a time for explicit `$bridge-pull-review` or `$bridge-pull-queue` use;
off mode does not review or deliver them automatically.
