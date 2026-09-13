import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkpointDecisionError, createCheckpoint, forcePublishError } from "../checkpoint-policy.js";
import { stopHookOutput } from "../claude-hook-output.js";
import { autoRoundLimitError, autoRoundLimitForMode, modeAfterUserDecision, reviewTurnCompletion } from "../mode-policy.js";
import { featureKey, reviewerRoot } from "../paths.js";
import { maxReviewPolicyBytes, readPolicyFile, writePolicyFile } from "../policy-store.js";
import { buildPublishedFeedback } from "../published-feedback.js";
import {
  buildPulledReviewPrompt,
  buildReviewContextSeed,
  buildReviewPrompt,
  compactedPolicyReminder,
  composeReviewPolicy,
  reviewContextSnapshot
} from "../review-prompt.js";
import { StateStore } from "../store.js";
import { FeaturePair } from "../types.js";
import { buildQuestionAdvisoryPrompt, createQuestionAdvisory, questionsFromHook } from "../question-advisory.js";
import { migrateClaudeSessionLifecycle, recordClaudeSession } from "../claude-session.js";
import { bridgeVersion } from "../version.js";
import { planAutoDelivery } from "../auto-delivery.js";
import { CodexThreadBusyError, isCodexThreadBusyError } from "../codex-turn-policy.js";
import { runSingleFlight } from "../single-flight.js";
import {
  autoDecisionError,
  buildAutoContinuation,
  buildAutoCycleStatus,
  resolveAutoReview
} from "../auto-review.js";
import { captureClaudeMessage, createPulledReview, pullQueueError, pullReviewError } from "../pulled-message.js";
import { readDesktopNotificationsEnabled, readInstanceDefaultMode } from "../instance-config.js";
import { checkpointDeferralError, formatBackgroundTasks, normalizeBackgroundTasks } from "../interim-review.js";

function pair(overrides: Partial<FeaturePair> = {}): FeaturePair {
  return {
    feature: "checkout-retry",
    displayName: "Checkout Retry",
    projectRoot: path.resolve("sample-project"),
    mode: "manual",
    status: "idle",
    autoRound: 0,
    autoRoundLimit: null,
    pmSeeded: true,
    updatedAt: new Date(0).toISOString(),
    ...overrides
  };
}

test("feature names become stable routing keys", () => {
  assert.equal(featureKey(" Checkout Retry / UI "), "checkout-retry-ui");
  assert.throws(() => featureKey(" --- "));
});

test("runtime metadata uses the package version", () => {
  const metadata = JSON.parse(fs.readFileSync(path.join(reviewerRoot, "package.json"), "utf8"));
  assert.equal(bridgeVersion, metadata.version);
});

test("Claude sessions become resumable only after durable conversation activity", () => {
  const current = pair({ claudeSessionId: "reserved-id", pmSeeded: false });
  migrateClaudeSessionLifecycle(current);
  assert.equal(current.claudeSessionStarted, false);

  recordClaudeSession(current, "observed-id", false);
  assert.equal(current.claudeSessionStarted, false);
  assert.equal(current.claudeSessionId, "observed-id");

  recordClaudeSession(current, "persisted-id", true);
  assert.equal(current.claudeSessionStarted, true);
  recordClaudeSession(current, "persisted-id", false);
  assert.equal(current.claudeSessionStarted, true);
});

test("legacy Claude session state repairs false resumability after promptless startup", () => {
  const promptless = pair({ claudeSessionStarted: true, pmSeeded: false });
  migrateClaudeSessionLifecycle(promptless);
  assert.equal(promptless.claudeSessionStarted, false);

  const established = pair({ claudeSessionStarted: true, pmSeeded: true });
  migrateClaudeSessionLifecycle(established);
  assert.equal(established.claudeSessionStarted, true);
});

test("state persists immutable routing and mutable mode", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "review-bridge-test-"));
  try {
    const filename = path.join(directory, "state.json");
    const store = new StateStore(filename);
    const created = store.ensure("Feature One", directory);
    store.update(created.feature, (current) => {
      current.claudeSessionId = "claude-id";
      current.codexThreadId = "codex-id";
      current.reviewContextSha256 = "context-id";
      current.mode = "once";
      current.autoRoundLimit = 2;
      current.pending = {
        id: "checkpoint-persisted",
        claudeMessage: "Done",
        autoDecision: "needs_user",
        createdAt: new Date(1).toISOString()
      };
      (current as FeaturePair & { lastAutoCycle?: unknown }).lastAutoCycle = {
        feature: "feature-one",
        checkpointId: "checkpoint-persisted",
        checkpointSequence: 1,
        codexTurnId: "turn-persisted",
        decision: "needs_user",
        outcome: "waiting-user",
        reviewRound: 1,
        startedAt: new Date(1).toISOString(),
        completedAt: new Date(2).toISOString(),
        durationMs: 1,
        headline: "Choose a tradeoff.",
        reportPath: "reviews/feature-one/checkpoint-1.md"
      };
      current.capturedClaudeMessage = captureClaudeMessage(
        "claude-id",
        "Captured handoff",
        new Date(3).toISOString(),
        "captured-id"
      );
    });
    const reloaded = new StateStore(filename).get("feature-one");
    assert.equal(reloaded?.claudeSessionId, "claude-id");
    assert.equal(reloaded?.codexThreadId, "codex-id");
    assert.equal(reloaded?.reviewContextSha256, "context-id");
    assert.equal(reloaded?.mode, "once");
    assert.equal(reloaded?.autoRoundLimit, 2);
    assert.equal(reloaded?.pending?.autoDecision, "needs_user");
    assert.equal(reloaded && "lastAutoCycle" in reloaded, false);
    assert.equal(reloaded?.capturedClaudeMessage?.message, "Captured handoff");
    assert.throws(() => store.ensure("Feature One", path.dirname(directory)));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("legacy policy-only state forces the combined bridge context to be reseeded", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "review-bridge-legacy-context-"));
  try {
    const filename = path.join(directory, "state.json");
    fs.writeFileSync(filename, `${JSON.stringify({
      version: 1,
      pairs: {
        "checkout-retry": {
          ...pair({ codexThreadId: "codex-id" }),
          autoRoundLimit: undefined,
          reviewPolicySha256: "legacy-policy-only-hash"
        }
      }
    })}\n`, "utf8");
    const loaded = new StateStore(filename).get("checkout-retry");
    assert.equal(loaded?.reviewContextSha256, undefined);
    assert.equal("reviewPolicySha256" in (loaded ?? {}), false);
    assert.equal(loaded?.autoRoundLimit, 3);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("legacy pending workstream context remains available for replacement Codex threads", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "review-bridge-workstream-context-"));
  try {
    const filename = path.join(directory, "state.json");
    fs.writeFileSync(filename, `${JSON.stringify({
      version: 1,
      pairs: {
        "checkout-retry": pair({
          codexThreadId: "codex-id",
          pmSeeded: false,
          initialPrompt: "Build the approved retry feature."
        })
      }
    })}\n`, "utf8");
    const loaded = new StateStore(filename).get("checkout-retry");
    assert.equal(loaded?.workstreamContext, "Build the approved retry feature.");
    assert.equal(loaded?.workstreamContextThreadId, undefined);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("review prompts retain a compact read-only checkpoint contract", () => {
  const current = pair({ status: "reviewing" });
  const prompt = buildReviewPrompt(current, "Implementation complete.");
  assert.match(prompt, /strictly read-only/i);
  assert.match(prompt, /Latest Claude message:\nImplementation complete\./);
  assert.ok(prompt.length < 750);
});

test("the stable bridge protocol and review policy are versioned once as thread context", () => {
  const current = pair({ status: "reviewing" });
  const context = reviewContextSnapshot("Baseline policy.\n\nApplication-only requirement.");
  const seed = buildReviewContextSeed(current, context);
  const prompt = buildReviewPrompt(current, "Implementation complete.");

  assert.match(seed, new RegExp(context.sha256));
  assert.match(seed, /Application-only requirement/);
  assert.match(seed, /review_bridge_record_auto_decision/);
  assert.match(seed, /review_bridge_defer_checkpoint/);
  assert.match(seed, /never JSON/i);
  assert.match(seed, /Do not generate a cycle recap/i);
  assert.match(seed, /every subsequent bridge-injected checkpoint/i);
  assert.doesNotMatch(prompt, /Application-only requirement/);
  assert.match(prompt, /protocol and review policy established in this thread/i);
  assert.ok(seed.length > prompt.length);
});

test("automatic review prompts request a control tool and human-readable response", () => {
  const current = pair({
    mode: "auto",
    status: "reviewing",
    pending: { id: "checkpoint-auto", sequence: 1, claudeMessage: "Done", createdAt: new Date(1).toISOString() }
  });
  const prompt = buildReviewPrompt(current, "Implementation complete.", current.pending);
  assert.match(prompt, /review_bridge_record_auto_decision/);
  assert.match(prompt, /feature `checkout-retry`/i);
  assert.match(prompt, /checkpoint `checkpoint-auto`/i);
  assert.match(prompt, /concise Markdown/i);
  assert.match(prompt, /Never broaden authorization/i);
  assert.match(prompt, /needs_user = choice/i);
  assert.match(prompt, /0\/unlimited/i);
  assert.doesNotMatch(prompt, /cycle report/i);
  assert.ok(prompt.length < 1_000);
});

test("interim review prompts expose bounded background work and allow findings or silent deferral", () => {
  const tasks = normalizeBackgroundTasks([
    { id: "agent-1", type: "subagent", status: "running", description: "Inspect reconnect handling", agent_type: "Explore" },
    { id: "shell-1", type: "shell", status: "running", command: "npm test" },
    null,
    { id: "missing-status", type: "shell" }
  ]);
  assert.equal(tasks.length, 2);
  assert.match(formatBackgroundTasks(tasks), /subagent agent-1 \(running\).*Inspect reconnect handling.*agent: Explore/);
  assert.match(formatBackgroundTasks(tasks), /shell shell-1 \(running\).*command: npm test/);
  assert.equal(normalizeBackgroundTasks(Array.from({ length: 12 }, (_, index) => ({
    id: `task-${index}`,
    type: "shell",
    status: "running"
  }))).length, 10);

  const current = pair({ mode: "auto", status: "reviewing" });
  current.pending = createCheckpoint(
    current,
    "checkpoint-interim",
    "I completed the parser and am waiting for the test agent.",
    new Date(1).toISOString(),
    "stop",
    tasks
  );
  const prompt = buildReviewPrompt(current, current.pending.claudeMessage, current.pending);
  assert.equal(current.pending.interim, true);
  assert.match(prompt, /Background work still in flight/);
  assert.match(prompt, /exactly one control tool/);
  assert.match(prompt, /review_bridge_defer_checkpoint/);
  assert.match(prompt, /Do not choose pass or pass_continue/);
  assert.match(autoDecisionError(current, current.pending.id, "pass") ?? "", /cannot pass or continue/i);
  assert.equal(autoDecisionError(current, current.pending.id, "revise"), undefined);
});

test("checkpoint deferral is limited to the active undecided interim review", () => {
  const tasks = normalizeBackgroundTasks([{ id: "agent-1", type: "subagent", status: "running" }]);
  const current = pair({ mode: "manual", status: "reviewing" });
  current.pending = createCheckpoint(current, "checkpoint-interim", "Waiting.", new Date(1).toISOString(), "stop", tasks);
  assert.equal(checkpointDeferralError(current, "checkpoint-interim"), undefined);
  assert.match(checkpointDeferralError(current, "stale") ?? "", /not the active checkpoint/i);
  current.pending.deferDecision = true;
  assert.match(checkpointDeferralError(current, "checkpoint-interim") ?? "", /already recorded/i);
  assert.match(autoDecisionError({ ...current, mode: "auto" }, "checkpoint-interim", "revise") ?? "", /deferral is already recorded/i);

  current.pending = createCheckpoint(current, "checkpoint-final", "Done.");
  assert.match(checkpointDeferralError(current, "checkpoint-final") ?? "", /background work in flight/i);
});

test("pulled review prompts are user-only and never request automatic control", () => {
  const current = pair({ mode: "off" });
  const captured = captureClaudeMessage(
    "claude-session",
    "Please review this completed change.",
    new Date(1).toISOString(),
    "captured-1"
  );
  const prompt = buildPulledReviewPrompt(
    current,
    createPulledReview(captured, new Date(2).toISOString(), "pulled-1")
  );
  assert.match(prompt, /review-only advisory for the user/i);
  assert.match(prompt, /Bridge mode: off/);
  assert.match(prompt, /Latest captured Claude message:\nPlease review this completed change\./);
  assert.doesNotMatch(prompt, /review_bridge_record_auto_decision/);
});

test("captured handoffs can be reviewed and queued independently once", () => {
  const captured = captureClaudeMessage(
    "claude-session",
    "Implementation complete.",
    new Date(1).toISOString(),
    "captured-1"
  );
  const current = pair({ mode: "off", capturedClaudeMessage: captured });

  assert.equal(pullReviewError(current), undefined);
  assert.match(pullQueueError(current) ?? "", /requires bridge mode manual, once, or auto/i);

  current.capturedClaudeMessage!.reviewRequestedAt = new Date(2).toISOString();
  assert.match(pullReviewError(current) ?? "", /already queued or active/i);
  current.capturedClaudeMessage!.reviewedAt = new Date(3).toISOString();
  assert.match(pullReviewError(current) ?? "", /already been reviewed/i);

  current.mode = "auto";
  assert.equal(pullQueueError(current), undefined);
  current.capturedClaudeMessage!.queueRequestedAt = new Date(4).toISOString();
  current.capturedClaudeMessage!.queueCheckpointId = "checkpoint-1";
  assert.match(pullQueueError(current) ?? "", /already been queued/i);
});

test("pull validation rejects conflicting bridge work and permits a newer capture", () => {
  const current = pair({
    mode: "manual",
    capturedClaudeMessage: captureClaudeMessage(
      "claude-session",
      "First handoff",
      new Date(1).toISOString(),
      "captured-1"
    )
  });
  current.pending = createCheckpoint(current, "checkpoint-live", "Live handoff");
  assert.match(pullReviewError(current) ?? "", /checkpoint is already pending/i);
  assert.match(pullQueueError(current) ?? "", /checkpoint is already pending/i);

  current.pending = undefined;
  current.capturedClaudeMessage!.reviewRequestedAt = new Date(2).toISOString();
  current.capturedClaudeMessage!.reviewedAt = new Date(3).toISOString();
  current.capturedClaudeMessage = captureClaudeMessage(
    "claude-session",
    "Newer handoff",
    new Date(4).toISOString(),
    "captured-2"
  );
  assert.equal(pullReviewError(current), undefined);
  assert.equal(pullQueueError(current), undefined);

  const checkpoint = createCheckpoint(current, "checkpoint-pull", "Newer handoff", new Date(5).toISOString(), "pull-queue");
  assert.equal(checkpoint.source, "pull-queue");
});

test("compaction adds one policy-file reminder instead of duplicating policy content", () => {
  const current = pair({ reviewContextCompacted: true });
  const reminder = compactedPolicyReminder(current);
  const prompt = buildReviewPrompt(current, "Review after compaction.");
  assert.match(reminder ?? "", /re-read the baseline policy/i);
  assert.match(prompt, /Context maintenance: Codex compacted this thread/);
  assert.doesNotMatch(prompt, /Application-only requirement/);
});

test("single-flight initialization shares one operation without adding duplicate work", async () => {
  const inFlight = new Map<string, Promise<string>>();
  let calls = 0;
  let unblock!: () => void;
  const blocked = new Promise<void>((resolve) => { unblock = resolve; });
  const operation = async (): Promise<string> => {
    calls++;
    await blocked;
    return "thread-1";
  };
  const first = runSingleFlight(inFlight, "feature", operation);
  const second = runSingleFlight(inFlight, "feature", operation);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  unblock();
  assert.deepEqual(await Promise.all([first, second]), ["thread-1", "thread-1"]);
  assert.equal(inFlight.size, 0);
});

test("automatic delivery distinguishes transport completion from model completion", () => {
  assert.deepEqual(planAutoDelivery("revise", true), {
    outcome: "revision-sent", status: "waiting-claude", clearPending: true, queueForNextPrompt: false
  });
  assert.deepEqual(planAutoDelivery("revise", false), {
    outcome: "revision-queued", status: "waiting-claude", clearPending: true, queueForNextPrompt: true
  });
  assert.deepEqual(planAutoDelivery("continue", false), {
    outcome: "continuation-awaiting-user", status: "waiting-user", clearPending: false, queueForNextPrompt: false
  });
});

test("Codex active-turn conflicts are retryable but unrelated failures are not", () => {
  assert.equal(isCodexThreadBusyError(new CodexThreadBusyError("thread-1")), true);
  assert.equal(isCodexThreadBusyError(new Error("thread already has an active turn")), true);
  assert.equal(isCodexThreadBusyError(new Error("authentication failed")), false);
});

test("application review policy overlays the generic baseline", () => {
  assert.equal(composeReviewPolicy("Baseline", ""), "Baseline");
  assert.match(composeReviewPolicy("Baseline", "Require browser evidence."), /Baseline[\s\S]*Application-specific[\s\S]*browser evidence/);
});

test("policy writes are bounded and protected by an expected hash", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "review-policy-test-"));
  const filename = path.join(directory, "review-policy.local.md");
  try {
    const created = writePolicyFile("# Local policy", null, filename);
    assert.equal(created.created, true);
    assert.equal(readPolicyFile(filename)?.sha256, created.sha256);
    assert.equal(fs.readFileSync(filename, "utf8"), "# Local policy\n");
    assert.throws(() => writePolicyFile("# Stale", null, filename), /changed since it was inspected/i);

    const updated = writePolicyFile("# Updated policy", created.sha256.toUpperCase(), filename);
    assert.equal(updated.created, false);
    assert.equal(fs.readFileSync(filename, "utf8"), "# Updated policy\n");
    assert.throws(() => writePolicyFile(" ", updated.sha256, filename), /cannot be empty/i);
    assert.throws(() => writePolicyFile("x".repeat(maxReviewPolicyBytes), updated.sha256, filename), /byte limit/i);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("new checkpoints supersede unpublished work monotonically", () => {
  const current = pair({ status: "waiting-user" });
  const first = createCheckpoint(current, "checkpoint-1", "First handoff", new Date(1).toISOString());
  current.pending = { ...first, codexResponse: "Old review" };
  current.checkpointSequence = first.sequence;
  const second = createCheckpoint(current, "checkpoint-2", "Latest handoff", new Date(2).toISOString());
  assert.equal(second.sequence, 2);
  assert.deepEqual(second.supersedes, { id: "checkpoint-1", sequence: 1 });
  assert.match(buildReviewPrompt(current, second.claudeMessage, second), /supersedes unpublished checkpoint #1/i);
});

test("publish decisions bind to the latest completed checkpoint", () => {
  const current = pair({
    status: "reviewing",
    pending: { id: "checkpoint-2", sequence: 2, claudeMessage: "Latest", createdAt: new Date(2).toISOString() }
  });
  assert.match(checkpointDecisionError(current, "checkpoint-1", true) ?? "", /superseded/);
  assert.match(checkpointDecisionError(current, "checkpoint-2", true) ?? "", /still under review/);
  current.status = "waiting-user";
  current.pending!.codexResponse = "Latest review";
  assert.equal(checkpointDecisionError(current, "checkpoint-2", true), undefined);
});

test("force publication is restricted to idle unheld manual recovery", () => {
  const current = pair({ codexThreadId: "thread-1" });
  assert.equal(forcePublishError(current, "thread-1", "Recovered review"), undefined);
  assert.match(forcePublishError(current, "wrong-thread", "Recovered review") ?? "", /does not match/);
  current.pending = { id: "checkpoint-3", claudeMessage: "Latest", createdAt: new Date(3).toISOString() };
  assert.match(forcePublishError(current, "thread-1", "Recovered review") ?? "", /checkpoint is pending/);
});

test("published feedback blocks Claude and remains advisory", () => {
  const feedback = buildPublishedFeedback("Finding one.");
  assert.match(feedback, /challenge or adapt/i);
  assert.match(feedback, /Do not comply mechanically/i);
  assert.match(feedback, /Finding one\./);
  assert.equal(buildPublishedFeedback(feedback), feedback);
  assert.deepEqual(stopHookOutput({ kind: "feedback", text: feedback }), {
    decision: "block",
    reason: feedback,
    systemMessage: "Reviewer Agent's review received; Claude is now challenging or adapting it."
  });
  assert.deepEqual(stopHookOutput({
    kind: "allow",
    systemMessage: "Automatic review cycle complete."
  }), { systemMessage: "Automatic review cycle complete." });
  const continuation = buildAutoContinuation("Merge the approved PR, update main, then run /opsx:explore.");
  assert.match(continuation, /already authorized/i);
  assert.match(continuation, /not new authorization/i);
  assert.deepEqual(stopHookOutput({ kind: "continue", text: continuation }), {
    decision: "block",
    reason: continuation,
    systemMessage: "Independent review gate passed; Claude is continuing the already-authorized workflow."
  });
});

test("persistent modes remain armed until explicitly disabled", () => {
  assert.equal(modeAfterUserDecision("manual"), "manual");
  assert.equal(modeAfterUserDecision("once"), "off");
  assert.equal(modeAfterUserDecision("auto"), "auto");
  assert.equal(modeAfterUserDecision("off"), "off");
});

test("review turn completion distinguishes user interruption from genuine failure", () => {
  assert.equal(reviewTurnCompletion("completed", "Review body"), "completed");
  assert.equal(reviewTurnCompletion("interrupted", "Partial review"), "interrupted");
  assert.equal(reviewTurnCompletion("failed", "Failure details"), "failed");
  assert.equal(reviewTurnCompletion("completed", "  "), "failed");
  assert.equal(modeAfterUserDecision("auto"), "auto");
  assert.equal(modeAfterUserDecision("manual"), "manual");
  assert.equal(modeAfterUserDecision("once"), "off");
});

test("automatic round limits accept unlimited or a positive per-cycle bound", () => {
  assert.equal(autoRoundLimitError("auto", undefined), undefined);
  assert.equal(autoRoundLimitForMode("auto", undefined), null);
  assert.equal(autoRoundLimitError("auto", 2), undefined);
  assert.equal(autoRoundLimitForMode("auto", 2), 2);
  assert.match(autoRoundLimitError("auto", 0) ?? "", /positive safe integer/i);
  assert.match(autoRoundLimitError("auto", 1.5) ?? "", /positive safe integer/i);
  assert.match(autoRoundLimitError("auto", "2") ?? "", /positive safe integer/i);
  assert.match(autoRoundLimitError("auto", Number.MAX_SAFE_INTEGER + 1) ?? "", /positive safe integer/i);
  assert.match(autoRoundLimitError("manual", 2) ?? "", /only valid.*auto/i);
  assert.equal(autoRoundLimitForMode("manual", undefined), null);
});

test("automatic decisions bind to the active reviewing checkpoint", () => {
  const current = pair({
    mode: "auto",
    status: "reviewing",
    pending: { id: "checkpoint-auto", sequence: 2, claudeMessage: "Done", createdAt: new Date(2).toISOString() }
  });
  assert.equal(autoDecisionError(current, "checkpoint-auto", "revise"), undefined);
  assert.match(autoDecisionError(current, "checkpoint-auto", "pass_continue") ?? "", /requires the concrete/i);
  assert.equal(autoDecisionError(current, "checkpoint-auto", "pass_continue", "Run the approved spike."), undefined);
  assert.match(autoDecisionError(current, "checkpoint-auto", "pass", "Run the spike.") ?? "", /only valid/i);
  assert.match(autoDecisionError(current, "stale", "revise") ?? "", /not the active automatic checkpoint/i);
  assert.match(autoDecisionError(current, "checkpoint-auto", "invalid") ?? "", /invalid automatic decision/i);
  current.pending!.autoDecision = "revise";
  assert.match(autoDecisionError(current, "checkpoint-auto", "pass") ?? "", /already recorded/i);
  current.pending!.autoDecision = undefined;
  current.mode = "manual";
  assert.match(autoDecisionError(current, "checkpoint-auto", "pass") ?? "", /mode auto/i);
});

test("bounded automatic delivery allows exactly the configured unattended count", () => {
  const current = pair({
    mode: "auto",
    status: "reviewing",
    autoRoundLimit: 2,
    pending: {
      id: "checkpoint-auto",
      claudeMessage: "Done",
      autoDecision: "revise",
      createdAt: new Date(2).toISOString()
    }
  });

  current.autoRound = 0;
  assert.equal(resolveAutoReview(current, "First revision.").kind, "revise");
  current.autoRound = 1;
  assert.equal(resolveAutoReview(current, "Second revision.").kind, "revise");
  current.autoRound = 2;
  assert.deepEqual(resolveAutoReview(current, "A third revision needs approval."), {
    kind: "waiting-user",
    response: "A third revision needs approval.",
    reason: "round-limit"
  });

  current.autoRoundLimit = 1;
  current.autoRound = 0;
  current.pending!.autoDecision = "pass_continue";
  current.pending!.autoContinuation = "Run the already-approved validation.";
  assert.equal(resolveAutoReview(current, "Continue once.").kind, "continue");
  current.autoRound = 1;
  assert.equal(resolveAutoReview(current, "A second continuation needs approval.").kind, "waiting-user");
});

test("automatic review resolutions preserve readable prose and enforce configurable limits", () => {
  const current = pair({
    mode: "auto",
    status: "reviewing",
    autoRound: 1,
    autoRoundLimit: 3,
    pending: {
      id: "checkpoint-auto",
      sequence: 2,
      claudeMessage: "Done",
      autoDecision: "revise",
      createdAt: new Date(2).toISOString()
    }
  });
  assert.deepEqual(resolveAutoReview(current, "Fix the reconnect race."), {
    kind: "revise",
    feedback: "Fix the reconnect race."
  });

  current.autoRound = 3;
  assert.deepEqual(resolveAutoReview(current, "The revision limit needs a decision."), {
    kind: "waiting-user",
    response: "The revision limit needs a decision.",
    reason: "round-limit"
  });

  current.autoRoundLimit = null;
  assert.deepEqual(resolveAutoReview(current, "Continue fixing the reconnect race."), {
    kind: "revise",
    feedback: "Continue fixing the reconnect race."
  });

  current.autoRound = 2;
  current.autoRoundLimit = 2;
  current.pending!.autoDecision = "pass";
  assert.deepEqual(resolveAutoReview(current, "All findings are resolved."), {
    kind: "pass",
    reviewRounds: 3,
    summary: "All findings are resolved."
  });

  current.pending!.autoDecision = undefined;
  assert.equal(resolveAutoReview(current, "Readable fallback.").kind, "waiting-user");

  current.pending!.autoDecision = "needs_user";
  assert.deepEqual(resolveAutoReview(current, "Choose the compatibility tradeoff."), {
    kind: "waiting-user",
    response: "Choose the compatibility tradeoff.",
    reason: "needs-user"
  });

  current.autoRound = 1;
  current.autoRoundLimit = 2;
  current.pending!.autoDecision = "pass_continue";
  current.pending!.autoContinuation = "Merge the approved PR, update main, then run /opsx:explore.";
  assert.deepEqual(resolveAutoReview(current, "Gate 1 passed; Gate 2 remains."), {
    kind: "continue",
    reviewRounds: 2,
    summary: "Gate 1 passed; Gate 2 remains.",
    continuation: "Merge the approved PR, update main, then run /opsx:explore."
  });

  current.pending!.autoContinuation = undefined;
  assert.deepEqual(resolveAutoReview(current, "Continuation is missing."), {
    kind: "waiting-user",
    response: "Continuation is missing.",
    reason: "missing-continuation"
  });

  current.pending!.autoContinuation = "Run another authorized gate.";
  current.autoRound = 3;
  assert.deepEqual(resolveAutoReview(current, "The unattended limit needs a decision."), {
    kind: "waiting-user",
    response: "The unattended limit needs a decision.",
    reason: "round-limit"
  });

  const status = buildAutoCycleStatus(current.feature);
  assert.match(status, /Automatic review passed/i);
  assert.match(status, /just report checkout-retry/);
  assert.doesNotMatch(status, /All findings are resolved/);
  assert.equal(status.split("\n").length, 1);
});

test("new pairs inherit the instance default without changing existing pairs", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "review-bridge-default-mode-"));
  try {
    const store = new StateStore(path.join(directory, "state.json"));
    const automatic = store.ensure("Automatic Feature", directory, "auto");
    assert.equal(automatic.mode, "auto");
    assert.equal(automatic.autoRound, 0);
    assert.equal(automatic.autoRoundLimit, null);

    const existing = store.ensure("Automatic Feature", directory, "off");
    assert.equal(existing.mode, "auto");
    assert.equal(store.ensure("Disabled Feature", directory, "off").mode, "off");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("instance default mode is backward compatible and rejects invalid configuration", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "review-bridge-instance-config-"));
  const filename = path.join(directory, "bridge.local.json");
  try {
    fs.writeFileSync(filename, '{"projectRoot":"/tmp/project"}\n', "utf8");
    assert.equal(readInstanceDefaultMode(filename), "manual");
    for (const mode of ["off", "manual", "auto"] as const) {
      fs.writeFileSync(filename, `${JSON.stringify({ defaultMode: mode })}\n`, "utf8");
      assert.equal(readInstanceDefaultMode(filename), mode);
    }
    fs.writeFileSync(filename, '{"defaultMode":"once"}\n', "utf8");
    assert.throws(() => readInstanceDefaultMode(filename), /must be off, manual, or auto/i);
    fs.writeFileSync(filename, "not json\n", "utf8");
    assert.throws(() => readInstanceDefaultMode(filename), /JSON/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("desktop notifications default on and accept an explicit boolean setting", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "review-bridge-notifications-"));
  const filename = path.join(directory, "bridge.local.json");
  try {
    fs.writeFileSync(filename, '{}\n', "utf8");
    assert.equal(readDesktopNotificationsEnabled(filename), true);
    fs.writeFileSync(filename, '{"desktopNotifications":false}\n', "utf8");
    assert.equal(readDesktopNotificationsEnabled(filename), false);
    fs.writeFileSync(filename, '{"desktopNotifications":true}\n', "utf8");
    assert.equal(readDesktopNotificationsEnabled(filename), true);
    fs.writeFileSync(filename, '{"desktopNotifications":"off"}\n', "utf8");
    assert.throws(() => readDesktopNotificationsEnabled(filename), /must be true or false/i);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("AskUserQuestion hook input becomes a generic read-only advisory", () => {
  const input = {
    session_id: "claude-session",
    cwd: path.resolve("sample-project"),
    hook_event_name: "PreToolUse",
    tool_name: "AskUserQuestion",
    tool_use_id: "toolu-question-1",
    tool_input: {
      questions: [{
        question: "Which retry strategy should the client use?",
        header: "Retries",
        options: [
          { label: "Backoff", description: "Reduce load during failures." },
          { label: "Fixed delay", description: "Keep timing predictable." }
        ],
        multiSelect: false
      }]
    }
  };
  const advisory = createQuestionAdvisory(input, new Date(1).toISOString());
  assert.equal(advisory?.id, "toolu-question-1");
  assert.equal(advisory?.questions[0].options[1].label, "Fixed delay");

  const prompt = buildQuestionAdvisoryPrompt(pair(), advisory!);
  assert.match(prompt, /Claude question advisory/);
  assert.match(prompt, /Backoff: Reduce load/);
  assert.match(prompt, /strictly read-only/i);
  assert.match(prompt, /never publish or answer Claude automatically/i);
  assert.ok(prompt.length < 750);
});

test("question advisory parsing rejects non-question and malformed hook events", () => {
  assert.equal(questionsFromHook({
    session_id: "session",
    cwd: path.resolve("sample-project"),
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_use_id: "toolu-bash",
    tool_input: { questions: [] }
  }), undefined);
  assert.equal(createQuestionAdvisory({
    session_id: "session",
    cwd: path.resolve("sample-project"),
    hook_event_name: "PreToolUse",
    tool_name: "AskUserQuestion",
    tool_use_id: "toolu-bad",
    tool_input: { questions: [{ question: "Missing options", header: "Bad" }] }
  }), undefined);
});
