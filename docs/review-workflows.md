# Review workflows

The bridge keeps one Claude session and one persistent Codex thread paired to a
feature name. Use one feature name for one task, and create a new name for
unrelated work in the same application.

## The normal review loop

1. Give Claude the product or implementation task.
2. Claude produces a design, implementation, or verification handoff.
3. Its Stop hook starts a read-only review in the paired Codex thread.
4. Inspect the review and run `$bridge-publish` or `$bridge-cancel`.
5. Continue the workstream; manual mode remains armed for the next handoff.

Codex treats the worktree as authoritative. Claude's latest message is a handoff,
not a substitute for reading repository instructions, specifications, code,
tests, and diffs.

## Review modes

### Manual

Fresh installations default new workstreams to manual mode. An instance can
instead persist `manual`, `auto`, or `off` with `reviewer default-mode <mode>`
or by editing `defaultMode` in `bridge.local.json`. This affects only previously
unseen feature names; existing workstreams keep their stored modes. Default
automatic mode is unlimited.

In manual mode, every Claude Stop starts a review. Final handoffs remain held
until you make a decision:

- `$bridge-publish` sends the completed review, or your edited selection, to
  Claude.
- `$bridge-cancel` releases Claude without feedback.

Both decisions leave manual mode armed. A held Stop can remain open while you
read or discuss the review; the hook response streams without polling.

When a manual or once review becomes ready for that decision, the bridge sends
a desktop notification. Automatic passes and successful unattended revision or
continuation rounds remain quiet; automatic mode notifies when it pauses for a
decision, cannot deliver a continuation, or queues feedback that requires your
next Claude prompt. Completed Claude-question advice and explicitly pulled
reviews also notify. Silent interim deferrals do not.

Notifications are enabled by default. Use `reviewer notifications off|on`
through the PowerShell or Bash wrapper, `just notifications off|on`, or set the
boolean `desktopNotifications` field in `bridge.local.json`. The broker reads
the setting for each notification, so changing it does not require a restart.
Toast text includes only the workstream name and a generic action. Delivery is
best-effort via Windows notifications, macOS `osascript`, or Linux
`notify-send`; WSL uses Windows PowerShell interop. Missing notification tools,
desktop-session restrictions, and OS-level notification settings are logged but
never affect review delivery. Clicking a notification does not focus either
terminal.

### Once

`$bridge-once` arms only the next review. After you publish or cancel that
checkpoint, the bridge returns to off mode.

### Automatic

`$bridge-auto` keeps automatic review armed with unlimited unattended rounds.
Pass a positive integer, such as `$bridge-auto 2`, to bound unattended revision
or continuation deliveries per cycle. Each checkpoint ends in one of four
outcomes:

- `pass` releases a complete and clean workflow;
- `pass_continue` resumes one concrete next action that the user already
  authorized;
- `revise` returns actionable findings to Claude;
- `needs_user` pauses for a decision or unavailable required validation.

```mermaid
sequenceDiagram
    actor U as You
    participant C as Claude Code
    participant B as Local bridge
    participant R as Codex reviewer

    U->>R: $bridge-auto
    R->>B: Arm automatic mode

    loop Until pass or user decision (optional per-cycle unattended limit)
        C->>B: Stop with a completed handoff
        B->>R: Start a read-only review
        R->>R: Inspect the handoff and current worktree
        R-->>U: Show the Markdown review
        R->>B: Record the checkpoint decision
        B->>B: Update the live session report

        alt pass
            B-->>C: Allow Stop with a fixed success status
        else pass_continue
            B-->>C: Continue only the already-authorized next action
            C->>C: Continue the workflow
        else revise
            B-->>C: Return actionable findings
            C->>C: Challenge or adapt, then revise
        else needs_user or unattended limit
            Note over U,C: Claude remains held for your decision
            U->>R: Publish, edit, or cancel
            R->>B: Resolve the latest checkpoint
            B-->>C: Deliver feedback or release without it
        end
    end
```

Here, `loop` marks the part that can repeat and `alt` shows the mutually
exclusive decision outcomes.

Revision and continuation share the configured unattended-round counter. With
no argument the counter is unlimited; a positive integer limits how many such
deliveries may occur before the bridge pauses for the user. The bridge cannot
use continuation to create authorization or broaden the task. A final pass or a
human publish or cancel decision resets the unattended counter without
disarming automatic mode.

### Background work and interim Stops

Claude Code 2.1.145 and newer includes its in-flight background commands,
subagents, monitors, workflows, teammates, cloud sessions, and MCP tasks in the
Stop-hook input. The bridge marks such a Stop as interim and asks Codex to
inspect any completed parallel work that is already reviewable:

- actionable material findings follow the normal manual, once, or automatic
  delivery flow;
- a required choice follows the normal needs-user flow;
- otherwise Codex records a silent deferral, and Claude receives no feedback
  whose only purpose is to tell it to keep waiting.

Deferral keeps the selected mode armed, does not consume once mode, and neither
increments nor resets the automatic round counter. Scheduled cron wakeups are
not treated as background work because recurring schedules must not suppress a
final review indefinitely. If an older Claude Code version omits the structured
background-task field, the bridge preserves the normal review behavior.

### Live checkpoint report

Reviewer responses remain ordinary Markdown in the Codex terminal. The broker
also keeps an in-memory, per-feature report of every checkpoint created during
its current process, across manual, once, and automatic mode. Pending entries
are updated in place when they complete, are published, cancelled, deferred,
interrupted, superseded, fail, or are released by switching the bridge off. Question
advisories, pulled review-only advisories, and off-mode captures are not
checkpoints and do not appear.

Print the report without adding another model turn:

```text
just report your-feature-name
```

Without Just:

```powershell
.\scripts\powershell\reviewer.ps1 report --feature 'your-feature-name'
```

```bash
./scripts/shell/reviewer.sh report --feature your-feature-name
```

The default report shows a subject derived from the first meaningful line of
the initial request and includes complete Codex responses, but hides the rest
of that request and the Claude handoffs. Pass `--full` to either platform
command, or run `just report your-feature-name --full`, to include the complete
initial request and those handoffs. Checkpoint history is available only while
the bridge server is running and is discarded on shutdown. Changing modes does
not reset it; the initial request remains the paired workstream context.

### Off

`$bridge-off` disables Stop interception and structured-question advice. If a
Stop is currently held, turning the bridge off releases it without feedback.
The bridge retains only the latest completed assistant handoff it bypasses so
that it can be pulled later; it does not retain or parse Claude's transcript.

## Pull a handoff missed while off

Use `$bridge-pull-review` for a one-off, read-only opinion in Codex. It works
without changing off mode, creates no checkpoint or automatic decision, and
cannot publish or queue feedback for Claude.

Use `$bridge-pull-queue` when the result should re-enter Claude's workflow. First
arm `$bridge-manual`, `$bridge-once`, or `$bridge-auto`, then pull the captured
handoff. Manual and once produce the usual publish-or-cancel checkpoint. Auto
uses its existing pass, revise, continuation, and needs-user decisions and round
limit. The pulled checkpoint is not connected to a held Stop, so revision
feedback or an approved continuation is attached to Claude's next
user-submitted prompt. After that prompt, normal automatic interception can
continue unattended.

Each command can process a captured handoff once, independently: a review-only
pull does not prevent one later queue pull of the same handoff. A newer off-mode
Stop replaces the captured handoff and makes both commands available again.
Structured questions and partial turns are not pull candidates.

## Bridge commands

| Command | Purpose |
| --- | --- |
| `$bridge-init-policy` | Create or refresh the private application review policy. |
| `$bridge-init-tools` | Curate and approve application-specific validation tools. |
| `$bridge-manual` | Review every completed Claude handoff with human approval. |
| `$bridge-once` | Review only the next completed handoff. |
| `$bridge-auto [rounds]` | Arm unlimited automatic review, or bound unattended deliveries per cycle with a positive integer. |
| `$bridge-off` | Disable interception and question advice. |
| `$bridge-pull-review` | Review the latest off-mode handoff for the user only. |
| `$bridge-pull-queue` | Put the latest off-mode handoff through the currently armed checkpoint mode. |
| `$bridge-status` | Show mode, pairing, pending checkpoint, and recovery state. |
| `$bridge-publish` | Publish the latest completed checkpoint review. |
| `$bridge-cancel` | Release the latest checkpoint without feedback. |
| `$bridge-force-publish` | Queue feedback only when recovering with no held Stop. |

Published feedback is advisory. Claude is instructed to challenge or adapt it
against project evidence rather than accept it blindly.

## Structured question advice

When Claude calls `AskUserQuestion`, the bridge mirrors the structured question
and choices into the same Codex thread for read-only advice. Claude continues to
wait in its own question UI. Discuss the recommendation in Codex, then personally
submit the final selection to Claude.

Question advisories are not checkpoints and cannot be published. If Codex is
busy, advice is queued; a later Claude Stop discards obsolete queued advice and
prioritizes the newer review.

## Checkpoints and newer handoffs

Only one unpublished checkpoint can be current for a feature. If Claude finishes
again while a review is pending, the newer checkpoint wins: the bridge releases
the obsolete Stop, interrupts the obsolete review, and reassesses the current
worktree. Publish and cancel operations require the exact latest checkpoint, so
stale decisions are rejected.

## Status and recovery

Run `$bridge-status` when a review does not appear, Claude remains held, or
routing is unclear. It reports the feature's mode, immutable session and thread
IDs, pending checkpoint, captured off-mode handoff availability, queued question
advice, and queued next-prompt feedback.

Interrupting the active Codex review cancels only that checkpoint and releases
Claude without publishing partial output. It resets the current automatic
round cycle while leaving manual or automatic mode armed; once mode turns off.
A genuine failed or empty reviewer turn still fails open and disarms the bridge.

Normal publication uses `$bridge-publish`. Reserve `$bridge-force-publish` for
recovery after a restart, cancelled checkpoint, disconnected Stop hook, or a
manually pasted handoff when no Stop is held. Recovery feedback is delivered on
Claude's next user prompt.

For broker-level diagnosis, inspect ignored `runtime/bridge.log`. See
[Architecture](architecture.md) for routing, concurrency, persistence, and the
security model.
