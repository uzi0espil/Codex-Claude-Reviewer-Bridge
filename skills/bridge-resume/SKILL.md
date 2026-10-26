---
name: bridge-resume
description: Resume automatic reviews after standby by catching up from captured Claude context.
---

Use the paired feature and call `review_bridge_resume`. Requires auto mode.
Report the returned activity and backlog. Catch-up is asynchronous; use
`review_bridge_status` when the user wants progress. Do not repeatedly poll.

Historical messages provide context; only the latest handoff receives a fresh
review against the current worktree. Auto round settings are preserved. Resume
does not submit a prompt to Claude. With no held Stop, revisions attach to the
next user prompt and continuations require the usual user delivery decision.
If capture has a gap, report the error and ask the user how to repair the
missing context; never claim the full history was recovered.
