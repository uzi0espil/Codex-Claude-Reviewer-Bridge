# Architecture

## Instance boundary

The source repository is a template factory. Every generated reviewer clone is
permanently bound to one canonical application root and becomes that
application's `CODEX_HOME`. Its memories, sessions, skills, credentials, policy,
and bridge state are therefore isolated from unrelated repositories. Setup and
launch scripts treat an explicit project path as a consistency check and reject
rebinding.

## Components

- **Claude hooks** send `SessionStart`, `UserPromptSubmit`, `PreToolUse` for
  `AskUserQuestion`, and `Stop` events.
- **Local broker** owns pairing state, checkpoint ordering, approval mode, and
  held Stop responses.
- **Codex app-server** owns persistent review threads and executes injected
  read-only review turns.
- **App-server proxy** multiplexes the broker and one interactive Codex terminal
  over the broker's single upstream app-server connection.
- **Codex MCP server** exposes status, mode, publish, cancel, recovery, and one
  path-fixed application-policy writer to the interactive reviewer.
- **Codex terminal** connects remotely to the broker-managed proxy so hook turns
  and user conversation share one visible thread and notification stream.
- **Reviewer CLI** owns cross-platform instance creation, setup, updates, process
  lifecycle, and terminal launching. PowerShell and Bash are thin adapters to the
  same dependency-free Node entrypoint.

## Routing and context

A normalized feature name selects one stored pair. Routing uses immutable Claude
session and Codex thread UUIDs, not terminal titles. The first Claude user prompt
is injected into the Codex thread once. The stable bridge protocol and composed
generic and local review policy are injected together and identified by their
combined SHA-256. They are injected again only when that context changes, the
thread is replaced, or app-server emits a `contextCompaction` item. Later
checkpoints contain only checkpoint-specific control data, a short read-only
reminder, and Claude's latest assistant message; Codex reads the current worktree
for authoritative state.

The broker reserves a Claude UUID before launch, but `SessionStart` only proves
that Claude observed it. The session becomes resumable after `UserPromptSubmit`
or later durable conversation activity. Versioned state migration clears the
older false-positive flag for promptless startups, such as a CLI update that
closes the terminals before the first user message.

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

Broker startup is serialized with an atomic runtime lock. A caller first checks
the loopback health endpoint, waits for an active startup, and recovers a lock
whose owner exited (or whose owner metadata remained incomplete for more than a
minute). Shutdown is an authenticated
broker request rather than a platform-specific PID kill. It releases held Stop
hooks without feedback, terminates the managed Codex app-server, removes the
endpoint file, and exits.

## Modes

- `manual`: every Stop is reviewed and held for human approval; remains armed.
- `once`: the next Stop is reviewed; a user decision turns the bridge off.
- `auto`: persistent automatic review, bounded to three unattended feedback or
  continuation rounds per cycle. A control-only MCP tool records pass,
  `pass_continue`, revise, or needs-user while the reviewer response remains
  normal Markdown. Human publish or cancel decisions reset the round counter
  without disarming auto mode.
- `off`: Stop interception and question advice are bypassed, and any held Stop
  is released.

On `pass`, the Stop hook allows Claude to finish and supplies only a fixed
one-line `systemMessage`; it never places the Codex report or response headline
in Claude's hook output. Every automatic turn writes its complete round report
atomically beneath ignored `reviews/` and stores only the latest receipt metadata
in pair state. Codex is explicitly told not to generate an additional cycle
recap. `reviewer report` walks backward from that receipt to the previous final
pass and assembles every completed response in the latest workflow cycle. A
human decision may reset the unattended safety counter without splitting this
user-visible cycle. The scan tolerates gaps from superseded checkpoints and does
not start a model turn. This remains a deterministic
fallback because Codex's remote app-server protocol is experimental. The proxy
intercepts the terminal's duplicate initialization, remaps bidirectional
JSON-RPC request IDs, and forwards upstream notifications to the terminal while
the broker consumes the same events. The report is never used as Stop feedback,
queued Claude context, or an injected second Codex history item. Only `once`
disarms itself after a user decision; `manual` and `auto` remain armed until
explicitly switched off.

`pass_continue` is distinct from final `pass`. It is valid only when the current
review gate is clean and the next concrete action was already authorized by the
user. The report remains out of band; the Stop hook receives only a bounded
continuation instruction and blocks the Stop so Claude resumes. The instruction
explicitly forbids treating Codex as new authorization or expanding scope. A
continuation increments the same unattended round counter as revise feedback;
the next clean, workflow-complete checkpoint resets it on final `pass`.

The paired Codex TUI is launched with `--no-alt-screen`. Broker-started app-server
turns therefore remain in terminal scrollback even if a later turn redraws the
interface; this does not inject another model-visible item.

All hook-injected Codex turns use `approvalPolicy: never`, a read-only sandbox,
and network access for research. Interactive write access is a separate explicit
permission profile and does not weaken injected checkpoint reviews.

## Persistence and privacy

Ignored `runtime/state.json` contains pair identifiers, pending checkpoints,
the latest automatic-cycle receipt, question-advisory routing metadata, and
queued feedback. Ignored `reviews/` contains out-of-band automatic review
reports. `runtime/endpoint.json`
contains the ephemeral loopback URL,
bearer token, reviewer proxy URL, and broker PID. Both app-server sockets bind
only to loopback. The bridge never needs Claude's
full transcript path.

The generated Claude settings deny normal Claude tools access to the reviewer
home. This reduces accidental prompt discovery but is not an operating-system
sandbox: both processes run under the same user account.

The tracked `review-policy.md` is the generic baseline. An approved,
application-specific `review-policy.local.md` is ignored and merged after it.
The policy writer accepts no path, uses an expected SHA-256 to reject stale
updates, and is configured to prompt for user approval. It never writes the
application repository.
