---
name: bridge-pull-queue
description: Pull the latest Claude assistant handoff captured while the bridge was off into the currently armed manual, once, or automatic checkpoint flow. Use when the user wants the review outcome queued for Claude's next prompt.
---

Call `review_bridge_status` for the paired feature. Proceed only when mode is
`manual`, `once`, or `auto`, a captured off-mode handoff is available, and no
checkpoint or next-prompt feedback is already pending. Do not change modes
implicitly; if the bridge is off, tell the user to select the intended mode.

Call `review_bridge_pull_queue` with the feature. Confirm the returned checkpoint
and mode. Explain that this checkpoint is unheld: manual and once wait for the
usual `$bridge-publish` or `$bridge-cancel` decision, while auto records its
normal decision. Any revision or approved continuation is attached to Claude's
next user-submitted prompt; after that one prompt, armed automatic mode continues
normally. Repeating this command for the same captured handoff is rejected, but
`$bridge-pull-review` may still review it once for the user.
