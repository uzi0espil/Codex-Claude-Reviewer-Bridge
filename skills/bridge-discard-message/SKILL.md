---
name: bridge-discard-message
description: Discard an explicitly force-published message queued for Claude when the user requests its removal, without cancelling a checkpoint or automatic feedback.
---

Call `review_bridge_status` for the paired feature. If `explicitClaudeMessage`
is absent, report that no explicit message is queued.

Call `review_bridge_discard_message` with the feature and exact observed message
ID. Confirm removal only on success. A conflict means the queue changed; report
it rather than retrying against a different message. This works during standby
and does not publish feedback, cancel a checkpoint, or change review mode.
