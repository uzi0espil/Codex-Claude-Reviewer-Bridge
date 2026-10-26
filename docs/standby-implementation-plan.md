# Auto standby and context recovery implementation plan

Status: implemented on 2026-10-25. The original plan is retained below; see the
implementation and validation record at the end for delivered behavior and gaps.

## Outcome and terminology

Introduce **standby** as an activity state separate from the selected review
mode. An automatic workstream remains armed while Claude continues and the
bridge durably collects context. **Resume** catches Codex up and returns the
workstream to normal automatic review without requiring the user to reconstruct
the conversation.

Expose `$bridge-standby` and `$bridge-resume`. Status should read, for example,
`Auto · Standby · 8 handoffs collected · Reason: usage limit` and show a retry
time only when supported by reliable metadata. Count prompts and handoffs
separately; do not label every captured event a handoff.

The initial public feature applies to auto mode. Model activity independently
so manual-mode support can be added later without adding another bridge mode.
Keep existing `off`, manual, once, and normal auto semantics unless explicitly
described below. Existing `needs_user` and unattended-round-limit decisions
remain held checkpoints; they do not automatically become standby.

## Repository evidence

- `src/types.ts`: mode, checkpoint, and pairing state currently have no standby
  or context-journal representation.
- `src/broker.ts`: `/mode` clears pending state and queued feedback on off;
  `/hook/stop` overwrites a single off-mode capture. Review startup and completion
  failures switch the bridge off and clear the checkpoint.
- `src/app-server.ts`: completion events retain `turn.error`, but RPC failures
  are reduced to an Error message. Structured failure information needs to
  survive both paths before reliable usage-limit classification is possible.
- `src/store.ts`: pair state is persisted through atomic JSON replacement.
- `src/claude-hook.ts` and `scripts/reviewer.mjs`: installed hooks currently
  cover session start, prompt submission, question pre-tool use, and Stop.
  Question answers are not currently captured by a dedicated hook.
- `docs/architecture.md`: the bridge intentionally does not read full Claude
  transcripts; checkpoint reports are broker-lifetime data, not durable history.
- `src/auto-delivery.ts`: an unheld continuation requires user delivery; revisions
  may be queued for the next user prompt. Resume must respect that distinction.

## Behavioral contract

### Enter standby

1. Persist the standby reason and recovery policy before releasing any held Stop.
2. Preserve mode, Codex thread, workstream context, round counter, and round limit.
3. Preserve the active handoff and any undelivered feedback as historical context.
   Quarantine old feedback so a later prompt cannot deliver it while in standby.
4. Invalidate the current checkpoint's authority to publish or record decisions;
   interrupt its broker-owned review if running, then release Claude without
   partial feedback. Late completions must not change the new state.
5. Stop dispatching checkpoint reviews, question advisories, and queued pull
   advisories for this feature. Do not interrupt an unrelated interactive Codex
   turn. Serialize catch-up behind it.
6. Capture subsequent user prompts, completed assistant handoffs, structured
   questions and available answers, with session IDs and ordering metadata.
   Return immediately from Claude hooks without review feedback.

Manual standby never automatically wakes. Repeating the command is idempotent.
An explicit manual standby while waiting for capacity cancels automatic retries.

### Resume and catch up

1. Serialize resume with hooks and existing per-feature review transitions.
   Repeated resume requests must not create parallel catch-up jobs.
2. Freeze a backlog high-water mark. Deliver events chronologically with clear
   provenance: earlier events are history, not instructions to act on obsolete
   work or answers to old Claude questions.
3. Use bounded context batches and a durable consumption cursor. Retain originals;
   do not silently truncate or mark omitted content consumed. An oversized event
   must be split with stable identifiers and ordering.
4. After context delivery, review the latest captured handoff against the current
   worktree through one new checkpoint. Do not review every historical handoff.
   Preserve interim/background-task semantics for the selected latest handoff.
5. If only prompts/questions were collected and no reviewable handoff exists,
   deliver context and re-arm auto for the next Stop without inventing a checkpoint.
6. Events arriving during catch-up remain durable. A newer handoff supersedes an
   older recovery checkpoint through the normal latest-checkpoint policy. Do not
   publish a result that omitted newer captured work. Bound each dispatch and
   continue catching up while Claude remains active rather than dropping events.
7. Re-enable ordinary dispatch only when the pending backlog is accounted for.
   If no Stop is held, use existing next-prompt revision and user-required
   continuation delivery semantics; resume does not itself restart Claude.

Catch-up consumes no unattended rounds. A subsequent review/delivery uses the
existing counter rules. A failure during catch-up leaves unacknowledged events
available for retry. Original stored feedback is never automatically republished;
the fresh assessment replaces its delivery eligibility.

### Usage-limit standby

When auto is armed, a confirmed usage exhaustion from a broker-owned review,
question advisory, pull advisory, or catch-up operation enters standby with reason
`usage-limit`. Preserve the failed handoff before clearing its active checkpoint.
Do not derive bridge state from failures in arbitrary interactive terminal turns.

Distinguish exhausted usage from transient throttling, authentication failures,
network failures, empty responses, and unknown errors. Preserve existing failure
behavior for unclassified failures in the initial implementation; log the
classification without sensitive payloads. A failed attempt consumes no round.

- With a verified reset time, schedule one recovery attempt at or after reset.
- Persist the deadline and reconstruct it on broker restart. Timers run only
  while the broker is running and must re-check current state when they fire.
- If still exhausted, use newer reset metadata or bounded exponential backoff
  with jitter. Suggested fallback: 1, 2, 4, 8, then 15 minutes, with a maximum
  of five consecutive attempts before requiring manual resume. Never spin.
- Without a reliable reset time, remain in standby with `Reset time unknown`
  and require manual resume in the first release.
- Manual resume attempts recovery immediately; a repeated confirmed exhaustion
  returns to usage-limit standby without losing data.
- Notify once on entry and once on successful recovery; retries should not spam.
- Switching off, changing mode, or requesting manual standby invalidates the
  retry generation so stale timers cannot wake the feature.

These reset/retry rules are the proposed product policy, not a claim that the
installed app-server exposes reset metadata.

## Data and persistence design

Add optional pair fields with backward-compatible defaults:

- Activity: `active`, `standby`, or `catching-up`.
- Standby metadata: reason, entered timestamp, recovery policy, optional reset
  time, attempt count, next retry time, and transition generation.
- Context metadata: journal sequence, acknowledged cursor, target Codex thread,
  in-flight batch range, and catch-up generation.

Use a per-feature append-only journal below ignored `runtime/`, with stable
event IDs, monotonic sequences, event kind, source/session identity, timestamp,
and content. Keep large history outside `state.json` to avoid rewriting all
backlog data on every hook. Persist the event before acknowledging a hook;
reconcile journal tails and state cursors at startup. Define handling for a
partially written final record, invalid middle records, missing journal files,
and write failures. Surface capture gaps; never advertise complete history
after a failed write. Hooks remain fail-open for Claude.

Capture eligible events while auto is active as well as in standby, then advance
the cursor when successfully delivered. This preserves an in-flight handoff if
capacity fails before a review completes. Deduplicate only using reliable source
identity; identical text can represent distinct legitimate events.

Tie context acknowledgments to the Codex thread. A replacement thread must
receive the workstream seed and retained relevant journal history, rather than
inheriting a cursor for context it never received. Journal history is private
runtime data, distinct from the existing ephemeral checkpoint report.

Specify acknowledgment semantics before coding: a successful injection response
can acknowledge context delivery; review completion is a separate checkpoint
event. A crash after upstream acceptance but before local acknowledgment may
cause duplicate context. Use stable batch IDs and explicit replay labeling;
claim exactly-once delivery only if the actual protocol offers deduplication or
reconciliation. Do not assume it does.

Keep originals for the workstream in this initial release. Add storage-size
visibility and a documented explicit cleanup procedure; no automatic eviction
of unconsumed events. Use existing private-runtime conventions, generated safe
feature paths, restrictive permissions, and no message content in status/toasts.
The guarantee covers successfully captured hook events, not every token or tool
result in Claude's conversation and not activity while the broker is unavailable.

## Implementation phases

### 1. Verify external protocol and freeze the contract

- Inspect the installed Codex app-server schema/source and primary documentation
  for structured usage errors, rate-limit notifications, reset timestamps,
  retryability, and context injection limits/acknowledgments. Record the tested
  version and observed fixtures. Use the OpenAI documentation skill for this work.
- Verify Claude's supported post-question hook and answer payload in primary
  documentation and a representative fixture. Prefer targeted structured answer
  capture over full-transcript reading. If unavailable, explicitly document the
  gap and defer automatic answer capture; never infer the user's selection.
- Confirm hook retry identities and specify deduplication where identity exists.
- Record final state transitions, acknowledgment rules, batch bounds, and retry
  constants. Do not couple core standby delivery to optional reset metadata.

Exit: verified fixtures or named capability gaps, with implementable fallback
behavior. No unverified external enum or field name becomes production logic.

### 2. Add state, journal, and transition policies

- Update `src/types.ts`, `src/store.ts`, and `src/paths.ts`; add focused journal
  and standby-policy modules rather than embedding all logic in the broker.
- Normalize legacy pairs to active with an empty journal; preserve old limits.
- Implement durable append/recovery, sequence allocation, cursor reconciliation,
  and generation checks. Ensure feature and session isolation.
- Add pure transition policies for manual standby, usage standby, resume, off,
  mode changes, and restart recovery. Off keeps historical backlog but cancels
  catch-up and retries. Selecting a different mode leaves standby and does not
  implicitly replay the backlog; subsequent auto arming must expose a retained
  backlog as requiring resume before automatic feedback is dispatched.

Exit: state reload and journal recovery tests establish no silent backlog loss.

### 3. Wire capture and standby controls

- Update `/hook/prompt`, `/hook/stop`, `/hook/question`, and the verified answer
  hook in `src/broker.ts` and `src/claude-hook.ts`.
- Update hook generation in `scripts/reviewer.mjs` when answer capture is supported.
- Add authenticated `/standby` and `/resume` endpoints, corresponding MCP tools
  in `src/mcp-server.ts`, and `skills/bridge-standby` / `skills/bridge-resume`
  with agent metadata following existing conventions.
- Guard all dispatch, completion, decision, publish, queued-feedback, and pull
  paths. Superseded decisions must be rejected even when interrupts race.
- Preserve and quarantine pending feedback; release held Stops after persistence.

Exit: Claude can continue through multiple prompts and handoffs with zero Codex
dispatch or feedback delivery while standby is active.

### 4. Implement catch-up and fresh review

- Add bounded catch-up prompt construction and event/batch provenance.
- Integrate with `ensureCodexThread`, policy seeding, active-thread arbitration,
  `scheduleReview`, and checkpoint supersession.
- Keep the read-only review profile and existing approval boundaries for every
  broker-injected turn. Historical text creates no new authorization.
- Handle concurrent hooks, partial batch success, broker restart, thread
  replacement, disconnected Stops, interim work, and retry cancellation.
- Add recovery checkpoint outcomes to the existing report without turning the
  ephemeral report into the durable journal or replaying old question advisories.

Exit: one resume catches up in order and assesses the latest work without stale
feedback, parallel reviews, or unintended Claude continuation.

### 5. Implement capacity classification and recovery

- Preserve structured RPC errors in `src/app-server.ts`; share a tested
  classifier across startup failures and `CompletedTurn.error` handling.
- Route confirmed exhausted usage to the same standby transition, including
  advisory and catch-up paths. Keep feature-scoped state separate from any
  account-wide signal; a shared reset event must not wake manual standby.
- Add persisted, generation-checked retry scheduling and startup reconstruction
  only for verified reset metadata. Implement backoff and attempt bounds.
- Update `src/desktop-notifications.ts` with generic standby/recovery messages.

Exit: exhaustion before start or during a turn preserves context and settings;
verified recovery resumes catch-up without consuming failed-attempt rounds.

### 6. Finish user surfaces and documentation

- Extend public status with activity, reason, event/handoff counts, capture gaps,
  retry availability, and next deadline; hide journal bodies and raw errors.
- Update bridge-auto/off/status skills to explain retained backlog and resume.
- Update `README.md`, `docs/review-workflows.md`, and `docs/architecture.md` with
  standby behavior, delivery limits, hook coverage, persistence/privacy changes,
  restart behavior, cleanup, and migration instructions for installed hooks.
- Verify setup, update, generated configuration, and package staging include new
  skills/hooks and the existing MCP approval policy covers the new controls.
- Defer optional “catch up, stay in standby” until the main resume path is stable.

## Validation and acceptance

Add meaningful unit and broker integration tests, using a fake app-server and
temporary runtime directories. Refactor a testable broker lifecycle if needed;
do not rely solely on tests of isolated policy helpers.

Required scenarios:

1. Legacy pair migration preserves modes and round limits.
2. Manual standby during idle, review startup, running review, held user decision,
   pending advice, and queued next-prompt feedback; late results cannot publish.
3. Multiple prompts, questions/available answers, handoffs, interim metadata,
   hook retries, and repeated identical messages preserve correct ordering.
4. Resume with empty backlog, prompts only, one handoff, large split events, and
   many batches; new events arriving at batch and review completion boundaries.
5. Restart during standby, append, injection acknowledgment, catch-up, and retry;
   thread replacement replays retained context with duplicate labeling as needed.
6. Unheld recovery revisions queue for a prompt; unheld continuations require user
   action. No historical answer is submitted to Claude's question UI.
7. Usage exhaustion before turn start and during review/advice/catch-up; malformed
   errors, authentication, transient throttling, and generic failures are distinct.
8. Known, missing, stale, and changed reset deadlines; bounded failed retries;
   manual resume; manual standby/off/mode changes invalidate outstanding timers.
9. Journal write failures/corruption and missing history surface gaps while Claude
   remains fail-open. Status, logs, and notifications do not expose message text.
10. Existing manual/once/off, pull, auto rounds, latest-checkpoint guards, and
    read-only permission selection remain compatible.
11. Package/setup/update tests verify installed commands and supported answer hooks.

For implementation, run `npm run check`, targeted tests during development, then
`npm test` and `npm run test:just` when its prerequisites are available. Record
unavailable checks precisely. Finish with a controlled live paired-session smoke
test: standby, several Claude exchanges, restart, resume, fresh review, and
next-prompt delivery. Simulate quota errors through fixtures rather than spending
real credits to force exhaustion. Use fake clocks for deadline/backoff tests.

The initial plan was produced by repository inspection only. Subsequent
implementation validation is recorded below.

## Suggested delivery slices

1. Durable context journal and migration.
2. Manual auto-standby, resume, catch-up, commands, and status.
3. Verified usage-exhaustion classification and standby entry.
4. Reset-aware automatic recovery where supported, documentation, and packaging.

Each slice includes its relevant tests. Ship core standby even if automatic reset
detection is unavailable; explain that recovery then requires `$bridge-resume`.

## Implementation and validation record

Implemented: separate auto activity state, `$bridge-standby` / `$bridge-resume`
skills and MCP tools, durable chunked context journal, thread-specific cursors,
catch-up and latest-handoff review, feedback quarantine, stale-result guards,
structured usage-exhaustion standby, reset-aware bounded retries, status,
notifications, restart recovery, generated answer hooks, and user documentation.

External capabilities were checked against Codex CLI 0.163.0's generated
experimental app-server JSON schema and the official
[app-server documentation](https://developers.openai.com/codex/app-server).
The schema distinguishes `usageLimitExceeded` from `rateLimitExceeded` and
exposes `account/rateLimits/read` with Unix-second `resetsAt` values.
Automatic recovery is deliberately restricted to future exhausted-window reset
times in the default Codex bucket; unknown reset times require manual resume.
The targeted answer capture uses `PostToolUse`'s tool input/response and tool-use
ID, as documented in the [Claude hooks reference](https://code.claude.com/docs/en/hooks).

Implementation choices: torn records are not silently truncated or repaired;
resume blocks and preserves the original file for explicit repair. Delivery is
at least once with stable replay labels, not exactly once. The journal retains
original records; the status exposes bytes and the workflow docs describe manual
retirement cleanup. The published bootstrap package explicitly includes its
three public workflow/architecture documents, excluding this internal plan.

Validation includes focused controller/journal tests, an isolated real HTTP
broker plus fake WebSocket app-server, actual MCP standby/resume tool calls,
restart and next-prompt delivery, startup and mid-turn quota fixtures, late
completion rejection, cursor loss/corruption, split handoffs, retry cancellation,
thread replacement, interactive-turn deferral, and partial-batch recovery.

Final checks: `npm run check`, `npm test` (99 tests plus npm package smoke),
`npm run test:just`, and `git diff --check` all passed. Git reported only its
existing LF/CRLF conversion notice for `src/claude-hook.ts`.

A live disposable instance was exercised with Codex CLI 0.163.0 and Claude Code
2.1.310: actual `$bridge-standby`, two real Claude exchanges, broker restart,
actual `$bridge-resume`, and a real Codex automatic review ending in `pass`.
The changed requirement (cerulean to vermilion) reached the reviewer, which
confirmed the final vermilion handoff. Private per-run evidence is stored under
ignored `runtime/standby-live-*`; temporary auth copies are removed on exit.
The opt-in reproduction command is `node scripts/standby-live-smoke.mjs` after
building. It uses real model capacity and requires working existing CLI logins.
Final live-run evidence: `runtime/standby-live-SwwoOX/evidence.json` and
`runtime/standby-live-SwwoOX/review-report.md`. The test broker is shut down.

Residual validation limits: real credit exhaustion was not forced; quota and
reset behavior use verified protocol fixtures and bounded timer tests. The live
test did not interact with Claude's question UI; question/answer capture is
covered by the documented hook contract and broker fixtures. Capture cannot
recover events missed while the broker is unavailable. A crash at an upstream
acknowledgment boundary can replay the last context batch.
