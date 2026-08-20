# Architecture

## Components

- **Claude hooks** send `SessionStart`, `UserPromptSubmit`, `PreToolUse` for
  `AskUserQuestion`, and `Stop` events.
- **Local broker** owns pairing state, checkpoint ordering, approval mode, and
  held Stop responses.
- **Codex app-server** owns persistent review threads and executes injected
  read-only review turns.
- **Codex MCP server** exposes status, mode, publish, cancel, and recovery tools
  to the interactive reviewer.
- **Codex terminal** connects remotely to the broker-managed app-server so hook
  turns and user conversation share one visible thread.

## Routing and context

A normalized feature name selects one stored pair. Routing uses immutable Claude
session and Codex thread UUIDs, not terminal titles. The first Claude user prompt
is injected into the Codex thread once. Later checkpoints contain only Claude's
latest assistant message; Codex reads the current worktree for authoritative
state.

## Manual approval

The Stop endpoint flushes response headers immediately and sends JSON-compatible
whitespace every 30 seconds. The single event-driven request remains open until
publish or cancel without polling and without triggering Node's inactive HTTP
timeouts. Publication completes the response with JSON that the Claude hook
turns into either a blocking feedback reason or an allow decision.

If the connection genuinely disappears, the broker preserves the completed
review. A later publication reports `next-prompt` and attaches the feedback to
Claude's next `UserPromptSubmit`.

## Question advisories

When Claude calls `AskUserQuestion`, its `PreToolUse` hook sends the structured
question and options to `/hook/question`, then immediately returns no decision
or updated input. Claude therefore presents its normal question UI and waits for
the user. The broker starts a separately labeled, read-only advisory turn in the
same persistent Codex thread. The user can discuss the recommendation in Codex
and submits the final answer personally in Claude.

Question advisories never enter checkpoint or publication state. Claude's
`tool_use_id` deduplicates hook retries. If Codex already has an active turn,
the advisory remains in a per-feature queue and is dispatched by the next
app-server `turn/completed` event without polling. A later Claude Stop proves
the question has already been answered, so queued advice is discarded and an
in-flight advisory is interrupted in favor of the newer review checkpoint.

## Concurrency

One unpublished checkpoint may be current per feature. A newer Claude Stop:

1. installs a monotonically numbered checkpoint;
2. releases the obsolete Stop without feedback;
3. interrupts an obsolete in-flight Codex turn;
4. starts a new review in the same Codex thread.

Publish and cancel require the latest checkpoint UUID. Stale decisions are
rejected rather than silently applied to newer work.

## Modes

- `manual`: every Stop is reviewed and held for human approval; remains armed.
- `once`: the next Stop is reviewed; a user decision turns the bridge off.
- `auto`: structured pass/revise/needs-user decisions, bounded to three revise
  cycles.
- `off`: Stop interception and question advice are bypassed, and any held Stop
  is released.

All hook-injected Codex turns use `approvalPolicy: never`, a read-only sandbox,
and network access for research. Interactive write access is a separate explicit
permission profile and does not weaken injected checkpoint reviews.

## Persistence and privacy

Ignored `runtime/state.json` contains pair identifiers, pending checkpoints,
question-advisory routing metadata, and queued feedback. `runtime/endpoint.json`
contains the ephemeral loopback URL,
bearer token, app-server URL, and broker PID. The bridge never needs Claude's
full transcript path.

The generated Claude settings deny normal Claude tools access to the reviewer
home. This reduces accidental prompt discovery but is not an operating-system
sandbox: both processes run under the same user account.
