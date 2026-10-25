---
name: bridge-standby
description: Put armed automatic reviews on standby while preserving Claude context for later catch-up.
---

Use the paired feature and call `review_bridge_standby`. Requires auto mode.
Report the returned activity, reason, and backlog counts. Claude continues;
review feedback and question advice stop. The current Stop is released without
partial feedback. Auto settings and round counts are preserved. Repeating this
command cancels capacity recovery and leaves the feature in manual standby.

Use `$bridge-resume` to catch up and assess the latest handoff. Standby is not
off, and does not stop Claude or grant additional implementation permission.
