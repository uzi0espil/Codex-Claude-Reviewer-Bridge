---
name: bridge-manual
description: Keep every completed Claude response in the current paired workstream under read-only Codex review and human approval until explicitly disabled. Use for persistent manual bridge review or review of every Claude handoff without automatic publication.
---

Call `review_bridge_set_mode` with the paired feature and mode `manual`.
Use the feature name from bridge metadata in the current conversation.

Confirm that each subsequent Claude Stop will be reviewed read-only and held for
the user's `$bridge-publish` or `$bridge-cancel` decision. Explain that both
actions preserve manual mode; only `$bridge-off` disables it.
