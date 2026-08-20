---
name: bridge-publish
description: Publish the latest completed Codex review, optionally edited by the user, to the paired Claude session. Use for bridge publication, selective findings, rewording, or approval of pending reviewer feedback.
---

Call `review_bridge_status` with the paired feature. Publish only when the latest
pending checkpoint has status `waiting-user`; use its exact `pending.id` as
`checkpointId`. If it is still `reviewing`, explain that the newest review is
not ready.

Classify text following `$bridge-publish`:

- With no additional text, omit `feedback` to publish the complete pending review.
- For edit or selection instructions such as ignore, remove, select, append,
  prepend, or reword, apply the instruction to the substantive review visible in
  this conversation. Pass the fully composed result, never the instruction.
- For text introduced by `send exactly`, `verbatim feedback`, or `replace the
  review with`, pass only the explicit replacement.

Before publishing an edit, verify that requested findings remain and excluded
material is absent. If the referenced content is unavailable or ambiguous, ask
for the intended text instead of guessing.

Call `review_bridge_publish` with the feature, checkpoint ID, and composed
feedback when applicable. If the broker rejects a superseded ID, fetch status
again and do not reuse stale feedback.

Inspect `delivery`. For `stop-hook`, confirm immediate delivery to the held
Claude Stop. For `next-prompt`, explain that the Stop connection was lost and
feedback is queued for Claude's next user prompt. Report that `manual` remains
armed when returned.

Example: `$bridge-publish ignore finding 1; publish only finding 2` must send
finding 2 itself, not the sentence `ignore finding 1`.
