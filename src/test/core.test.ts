import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkpointDecisionError, createCheckpoint, forcePublishError } from "../checkpoint-policy.js";
import { stopHookOutput } from "../claude-hook-output.js";
import { modeAfterUserDecision } from "../mode-policy.js";
import { featureKey } from "../paths.js";
import { buildPublishedFeedback } from "../published-feedback.js";
import { buildReviewPrompt } from "../review-prompt.js";
import { StateStore } from "../store.js";
import { FeaturePair } from "../types.js";
import { buildQuestionAdvisoryPrompt, createQuestionAdvisory, questionsFromHook } from "../question-advisory.js";

function pair(overrides: Partial<FeaturePair> = {}): FeaturePair {
  return {
    feature: "checkout-retry",
    displayName: "Checkout Retry",
    projectRoot: path.resolve("sample-project"),
    mode: "manual",
    status: "idle",
    autoRound: 0,
    pmSeeded: true,
    updatedAt: new Date(0).toISOString(),
    ...overrides
  };
}

test("feature names become stable routing keys", () => {
  assert.equal(featureKey(" Checkout Retry / UI "), "checkout-retry-ui");
  assert.throws(() => featureKey(" --- "));
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
      current.mode = "once";
    });
    const reloaded = new StateStore(filename).get("feature-one");
    assert.equal(reloaded?.claudeSessionId, "claude-id");
    assert.equal(reloaded?.codexThreadId, "codex-id");
    assert.equal(reloaded?.mode, "once");
    assert.throws(() => store.ensure("Feature One", path.dirname(directory)));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("review prompts are independent, evidence-driven, and read-only", () => {
  const current = pair({ status: "reviewing" });
  const prompt = buildReviewPrompt(current, "Implementation complete.");
  assert.match(prompt, /independent/i);
  assert.match(prompt, /worktree/i);
  assert.match(prompt, /strictly read-only/i);
  assert.match(prompt, /Latest Claude message:\nImplementation complete\./);
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
});

test("manual mode persists until explicitly disabled", () => {
  assert.equal(modeAfterUserDecision("manual"), "manual");
  assert.equal(modeAfterUserDecision("once"), "off");
  assert.equal(modeAfterUserDecision("auto"), "off");
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
  assert.match(prompt, /target worktree/i);
  assert.match(prompt, /strictly read-only/i);
  assert.match(prompt, /personally submit the final answer in Claude/i);
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
