---
name: bridge-pull-queue
description: Pull the latest Claude assistant handoff captured while the bridge was off into a checkpoint without changing mode. Use when the user wants the review outcome queued for Claude's next prompt, including while interception stays off.
---

Call `review_bridge_status` for the paired feature. Proceed when a captured
off-mode handoff is available and no checkpoint, next-prompt feedback, or
review-only advisory is queued or active. Do not change modes: this command
also works while the bridge remains off.

Call `review_bridge_pull_queue` with the feature. Confirm the returned checkpoint
and mode. Explain that this checkpoint is unheld: off, manual, and once wait for
the usual `$bridge-publish` or `$bridge-cancel` decision, while auto records its
normal decision. Any revision or approved continuation is attached to Claude's
next user-submitted prompt. In off mode, review, publication, cancellation, and
delivery all leave interception off; cancellation queues no feedback. Armed
automatic mode continues normally after that prompt. Repeating this command for
the same captured handoff is rejected, but
`$bridge-pull-review` may still review it once for the user.
