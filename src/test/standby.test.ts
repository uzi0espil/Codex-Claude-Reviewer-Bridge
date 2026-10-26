import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ContextJournal, contextPartLength } from "../context-journal.js";
import { StandbyController, StandbyHost } from "../standby.js";
import { StateStore } from "../store.js";
import { AppServerRpcError } from "../app-server.js";
import { isUsageLimit, retryDeadline, usageResetAt } from "../usage-limit.js";

async function eventually(check: () => boolean) {
  for (let i = 0; i < 100; i++) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 5)); }
  assert.ok(check(), "Condition did not become true");
}

function fixture(t: test.TestContext, overrides: Partial<StandbyHost> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-standby-"));
  const store = new StateStore(path.join(root, "state.json"));
  const pair = store.ensure("feature", root, "auto");
  store.update(pair.feature, (value) => { value.codexThreadId = "thread"; value.autoRound = 2; value.autoRoundLimit = 4; });
  const journal = new ContextJournal(path.join(root, "context"));
  const injections: string[] = [];
  const reviews: string[] = [];
  const released: string[] = [];
  const notices: string[] = [];
  const host: StandbyHost = {
    ensureThread: async (value) => value, busy: () => false,
    inject: async (_thread, text) => { injections.push(text); },
    interrupt: async () => {}, release: (id) => { released.push(id); }, report: () => {},
    review: (_pair, handoff) => { reviews.push(handoff.content); },
    rateLimits: async () => ({}), notify: (kind) => { notices.push(kind); }, ...overrides
  };
  const controller = new StandbyController(store, journal, host);
  t.after(() => { controller.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const capture = (kind: "prompt" | "handoff" | "question" | "answer", content: string, sourceId?: string) =>
    controller.capture(pair, { kind, content, sessionId: "claude", sourceId });
  return { root, store, pair, journal, injections, reviews, released, notices, controller, capture };
}

test("standby captures chronological context and resumes only the latest handoff without resetting rounds", async (t) => {
  const f = fixture(t);
  f.controller.enter("feature", "user-requested");
  f.capture("prompt", "Requirement changed"); f.capture("handoff", "First attempt");
  f.capture("question", "Choose a color", "q1"); f.capture("answer", "Blue", "q1");
  f.capture("question", "Choose a color", "q1");
  f.capture("handoff", "Latest result");
  assert.equal(f.journal.read("feature").length, 5);
  assert.equal(f.injections.length, 0);
  f.controller.resume("feature"); f.controller.resume("feature");
  await eventually(() => f.pair.activity === "active");
  assert.deepEqual(f.reviews, ["Latest result"]);
  assert.equal(f.injections.length, 5);
  assert.match(f.injections[0], /Requirement changed/);
  assert.equal(f.pair.contextCursor, 5);
  assert.equal(f.pair.autoRound, 2); assert.equal(f.pair.autoRoundLimit, 4);
});

test("standby releases the held review and quarantines feedback; commands are idempotent", (t) => {
  const f = fixture(t);
  f.store.update("feature", (value) => {
    value.pending = { id: "held", claudeMessage: "Done", createdAt: "now", codexResponse: "Old feedback" };
    value.queuedClaudeContext = "Queued feedback";
  });
  f.controller.enter("feature", "user-requested");
  const generation = f.pair.standby!.generation;
  f.controller.enter("feature", "user-requested");
  assert.equal(f.pair.standby!.generation, generation);
  assert.deepEqual(f.released, ["held"]);
  assert.equal(f.pair.pending, undefined); assert.equal(f.pair.queuedClaudeContext, undefined);
  assert.deepEqual(f.journal.read("feature").map((event) => event.kind), ["handoff", "feedback"]);
});

test("split events survive restart and replacement threads replay retained context", async (t) => {
  const f = fixture(t);
  const content = "x".repeat(contextPartLength * 2 + 5);
  f.controller.enter("feature", "user-requested"); f.capture("handoff", content);
  assert.equal(f.journal.read("feature").length, 3);
  const restored = new StateStore(path.join(f.root, "state.json"));
  assert.equal(restored.get("feature")!.activity, "standby");
  f.controller.resume("feature");
  await eventually(() => f.pair.activity === "active");
  assert.deepEqual(f.reviews, [content]);
  f.store.update("feature", (value) => { value.codexThreadId = "replacement"; });
  f.controller.enter("feature", "user-requested"); f.controller.resume("feature");
  await eventually(() => f.injections.length === 6);
  assert.equal(f.pair.contextThreadId, "replacement");
});

test("new events during catch-up remain pending and the newer handoff wins", async (t) => {
  let append: (() => void) | undefined;
  const f = fixture(t, { inject: async () => { const action = append; append = undefined; action?.(); } });
  f.controller.enter("feature", "user-requested"); f.capture("handoff", "Old");
  append = () => f.capture("handoff", "New");
  f.controller.resume("feature");
  await eventually(() => f.pair.activity === "active");
  assert.deepEqual(f.reviews, ["New"]);
});

test("manual standby wins an in-flight resume and an exhausted response", async (t) => {
  let unblock!: () => void;
  const blocked = new Promise<void>((resolve) => { unblock = resolve; });
  const f = fixture(t, { inject: async () => blocked });
  f.controller.enter("feature", "user-requested"); f.capture("handoff", "Done");
  f.controller.resume("feature");
  await new Promise((resolve) => setTimeout(resolve, 5));
  f.controller.enter("feature", "user-requested"); unblock();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(f.pair.contextCursor ?? 0, 0); assert.deepEqual(f.reviews, []);
  await f.controller.exhausted("feature", { codexErrorInfo: "usageLimitExceeded" });
  assert.equal(f.pair.standby!.reason, "user-requested");
});

test("known usage exhaustion preserves a failed handoff and unknown reset requires manual resume", async (t) => {
  const f = fixture(t);
  f.capture("handoff", "Failed review");
  f.store.update("feature", (value) => { value.pending = { id: "failed", claudeMessage: "Failed review", createdAt: "now" }; });
  assert.equal(await f.controller.exhausted("feature", new AppServerRpcError({ data: { codexErrorInfo: "usageLimitExceeded" } })), true);
  assert.equal(f.pair.mode, "auto"); assert.equal(f.pair.activity, "standby");
  assert.equal(f.pair.standby!.nextRetryAt, undefined);
  assert.equal(f.journal.read("feature").length, 1);
  f.controller.resume("feature"); await eventually(() => f.pair.activity === "active");
  assert.deepEqual(f.reviews, ["Failed review"]);
});

test("corrupt or missing history and capture failures never silently resume", (t) => {
  const f = fixture(t);
  f.capture("handoff", "Done"); f.controller.enter("feature", "user-requested");
  fs.appendFileSync(f.journal.filename("feature"), '{"partial":');
  assert.throws(() => f.controller.resume("feature"), /Incomplete/);
  f.capture("prompt", "Cannot save");
  assert.equal(f.pair.contextGap, true); assert.equal(f.pair.activity, "standby");
  assert.throws(() => f.controller.resume("feature"), /gap/);
});

test("usage error classification and retry deadlines follow verified structured fields", () => {
  for (const error of [new Error("usage limit exceeded"), { codexErrorInfo: "rateLimitExceeded" }, { httpStatusCode: 429 }, { codexErrorInfo: "unauthorized" }]) {
    assert.equal(isUsageLimit(error), false);
  }
  assert.equal(isUsageLimit({ codexErrorInfo: "usageLimitExceeded" }), true);
  const snapshot = { rateLimits: { limitId: "codex", primary: { usedPercent: 100, resetsAt: 100 }, secondary: { usedPercent: 100, resetsAt: 200 } } };
  assert.equal(usageResetAt(snapshot, 0), 200_000);
  assert.equal(usageResetAt(snapshot, 300_000), undefined);
  assert.equal(usageResetAt({ rateLimits: { ...snapshot.rateLimits, limitId: "other" } }, 0), undefined);
  assert.equal(retryDeadline(200_000, 0, 0, () => 0), 201_000);
  assert.equal(retryDeadline(undefined, 0), undefined);
  assert.equal(retryDeadline(200_000, 5), undefined);
});

test("a reviewed held split handoff is reassessed in full after standby", async (t) => {
  const f = fixture(t);
  const content = "z".repeat(contextPartLength + 2);
  f.capture("handoff", content);
  f.store.update("feature", (value) => {
    value.contextCursor = 2; value.contextThreadId = "thread"; value.recoveryHandoffSequence = 2;
    value.pending = { id: "held", claudeMessage: content, createdAt: "now", contextSequence: 2, codexResponse: "Needs user" };
  });
  f.controller.enter("feature", "user-requested"); f.controller.resume("feature");
  await eventually(() => f.pair.activity === "active");
  assert.deepEqual(f.reviews, [content]);
});

test("missing unacknowledged journal data is detected before replacement thread replay", async (t) => {
  const f = fixture(t);
  f.capture("handoff", "Not delivered");
  f.controller.enter("feature", "user-requested");
  fs.unlinkSync(f.journal.filename("feature"));
  f.pair.codexThreadId = "replacement";
  assert.throws(() => f.controller.resume("feature"), /missing captured history/);
});

test("a persisted retry wakes once and manual standby invalidates a stale retry", async (t) => {
  const f = fixture(t);
  f.controller.enter("feature", "usage-limit");
  f.capture("prompt", "Context only");
  f.store.update("feature", (value) => { value.standby!.nextRetryAt = new Date(Date.now() + 5).toISOString(); });
  f.controller.armRetry(f.pair);
  await eventually(() => f.pair.activity === "active");
  assert.equal(f.injections.length, 1);
  assert.equal(f.pair.autoRound, 2);
  f.controller.enter("feature", "usage-limit");
  f.store.update("feature", (value) => { value.standby!.nextRetryAt = new Date(Date.now() + 5).toISOString(); });
  f.controller.armRetry(f.pair);
  f.controller.enter("feature", "user-requested");
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(f.pair.activity, "standby"); assert.equal(f.pair.standby!.reason, "user-requested");
});

test("busy interactive turns defer catch-up without being interrupted", async (t) => {
  let busy = true;
  const interrupts: string[] = [];
  const f = fixture(t, { busy: () => busy, interrupt: async (_thread, turn) => { interrupts.push(turn); } });
  f.controller.enter("feature", "user-requested"); f.capture("handoff", "Done"); f.controller.resume("feature");
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(f.injections, []); assert.deepEqual(interrupts, []);
  busy = false; f.controller.dispatch("feature");
  await eventually(() => f.pair.activity === "active");
  assert.deepEqual(f.reviews, ["Done"]);
});

test("a mid-batch failure preserves the durable cursor and retries only unacknowledged records", async (t) => {
  let injected = 0;
  const f = fixture(t, { inject: async () => {
    injected++; if (injected === 2) throw new Error("Lost connection");
  } });
  f.controller.enter("feature", "user-requested"); f.capture("prompt", "First"); f.capture("handoff", "Second");
  f.controller.resume("feature");
  await eventually(() => f.pair.activity === "standby");
  assert.equal(f.pair.contextCursor, 1);
  assert.equal(new StateStore(path.join(f.root, "state.json")).get("feature")!.contextCursor, 1);
  f.controller.resume("feature"); await eventually(() => f.pair.activity === "active");
  assert.equal(injected, 3); assert.deepEqual(f.reviews, ["Second"]);
});
