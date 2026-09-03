# Architecture

## Instance boundary

The source repository is a template factory. Every generated reviewer clone is
permanently bound to one canonical application root and becomes that
application's `CODEX_HOME`. Its memories, sessions, skills, credentials, policy,
and bridge state are therefore isolated from unrelated repositories. Setup and
launch scripts treat an explicit project path as a consistency check and reject
rebinding.

The public npm package is a stateless bootstrapper, not a reviewer home. By
default it clones the Git tag matching the npm package version, creates a local
reviewer branch that tracks `origin/main`, and runs setup inside that clone. npm's
cache never stores application policy, credentials, sessions, or bridge state.

## Components

- **Claude hooks** send `SessionStart`, `UserPromptSubmit`, `PreToolUse` for
  `AskUserQuestion`, and `Stop` events.
- **Local broker** owns pairing state, checkpoint ordering, approval mode, and
  held Stop responses.
- **Codex app-server** owns persistent review threads and executes injected
  read-only review turns.
- **App-server proxy** multiplexes the broker and one interactive Codex terminal
  over the broker's single upstream app-server connection.
- **Codex MCP server** exposes status, mode, publish, cancel, off-mode handoff
  pulling, recovery, and one path-fixed application-policy writer to the
  interactive reviewer.
- **Application review-tools MCP server** exposes scanner evidence and a
  path-fixed, prompt-gated manifest writer before onboarding. After approval, a
  fresh session also exposes one dynamic tool per approved recipe.
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

Even in off mode, the Stop hook receives the completed assistant handoff before
it immediately allows Claude to finish. The broker retains only the latest such
handoff. A pull-review starts a non-publishable advisory turn, while a pull-queue
creates a normal unheld checkpoint in the selected armed mode. Both wait behind
an active Codex turn, and a live checkpoint takes precedence over a queued pull
advisory.

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
- `auto`: persistent automatic review, unlimited by default or optionally
  bounded to a configured number of unattended feedback or continuation
  deliveries per cycle. A control-only MCP tool records pass,
  `pass_continue`, revise, or needs-user while the reviewer response remains
  normal Markdown. Human publish or cancel decisions reset the round counter
  without disarming auto mode.
- `off`: Stop interception and question advice are bypassed, any held Stop is
  released, and the latest bypassed assistant handoff remains available for
  explicit pulling.

On `pass`, the Stop hook allows Claude to finish and supplies only a fixed
one-line `systemMessage`; it never places the Codex report or response headline
in Claude's hook output. The broker keeps a per-feature checkpoint ledger in
memory for its complete process lifetime. Every manual, once, or automatic
checkpoint enters the ledger immediately and its entry is updated through
review, delivery, cancellation, supersession, mode-off release, or failure.
`reviewer report` requests a Markdown rendering through the authenticated local
broker API and does not start a model turn. The default rendering omits the full
initial request and Claude handoffs but shows a subject derived from the first
meaningful line of the initial request; `--full` includes the complete request
and handoffs. The proxy
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

All hook-injected Codex turns use `approvalPolicy: never` and explicitly select
the read-only `bridge-review` permission profile. Live web search remains enabled
for research. Interactive write access is a separate explicit permission profile;
each later injected turn reselects `bridge-review`, so interactive implementation
work does not weaken checkpoint reviews.

Setup scans the bound repository for language manifests, package scripts, common
task runners, Compose configuration, CI, and validation-like scripts. It extracts
GitHub Actions run steps into a non-executable structured inventory, classifying
validation gates separately from setup and support evidence. The ignored
`review-tools.detected.json` output is evidence only and is never loaded as an
executable manifest. `$bridge-init-tools` checks repository instructions and CI,
asks runner authorization separately from readiness, maps every requirement to
tools or an explicitly accepted gap, and preflights the complete proposal before
preview. The fixed writer validates its schema, detection revision, coverage,
runner policy, and immutable project binding, requires the previously observed
SHA-256, supplies the actual approval timestamp, and atomically replaces only
ignored `review-tools.local.json`. Version-1 manifests remain readable; all new
writes use version 2. Its MCP approval mode is `prompt`; all other tool
server capabilities are harmless until the approved manifest exists.

Approved runners use fixed argv execution with `shell: false`, bounded typed
inputs, repository-path validation, output caps, timeouts, and one active command
at a time. Host, Compose, existing-service execution, and staged-service
execution are language-neutral. Staged execution copies only an approved source
subtree to a unique container scratch directory, retrieves only declared
artifacts into ignored reviewer runtime storage, and attempts cleanup. Manifest
approval is standing authorization for those exact capabilities, not for an
arbitrary shell or implementation changes.

The manifest records runner authorization independently from readiness. Static mode performs no runtime command
and is the backward-compatible default. Trusted mode records the user's explicit
acceptance of runtime prerequisites after structural validation. Per-tool probe
mode executes only a fixed approved host or Compose runner and caches its result
under ignored reviewer runtime state for the approved duration. Doctor output
preserves the evidence basis, and no readiness mode can override an invalid
binding, missing path, Compose file, or host executable.

On native Windows, generated reviewer configuration selects the `unelevated`
sandbox implementation. This avoids making administrator-approved elevated
sandbox setup a hidden prerequisite for automatic reviews while retaining
restricted-token and ACL-based filesystem boundaries. Operators may configure
the stronger elevated sandbox after completing its one-time system setup.

## Persistence and privacy

Ignored `runtime/state.json` contains pair identifiers, pending checkpoints,
question-advisory routing metadata, the latest off-mode assistant handoff and
its pull state, and queued feedback. Session reports, including their Claude
handoffs and Codex responses, exist only in broker memory and are discarded on
shutdown; legacy files under ignored `reviews/` are not read or deleted.
`runtime/endpoint.json` contains the ephemeral loopback URL,
bearer token, reviewer proxy URL, and broker PID. Both app-server sockets bind
only to loopback. The bridge never reads or stores Claude's full transcript
path. Pulling cannot recover handoffs that occurred before a bridge version with
capture support was installed.

The generated Claude settings deny normal Claude tools access to the reviewer
home. This reduces accidental prompt discovery but is not an operating-system
sandbox: both processes run under the same user account.

The tracked `review-policy.md` is the generic baseline. An approved,
application-specific `review-policy.local.md` is ignored and merged after it.
The policy writer accepts no path, uses an expected SHA-256 to reject stale
updates, and is configured to prompt for user approval. It never writes the
application repository.

Scanner recommendations in `review-tools.detected.json` and approved recipes in
`review-tools.local.json` are also ignored and application-bound. Validation
artifacts are kept below ignored `runtime/review-tools/`. No manifest contains
credentials; approved runners inherit the reviewer's runtime environment when a
tool legitimately needs existing developer authentication.
