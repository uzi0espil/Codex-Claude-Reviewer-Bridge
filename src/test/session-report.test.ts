import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { SessionReportLedger } from "../session-report.js";
import { FeaturePair, PendingReview } from "../types.js";

function pair(feature: string, mode: FeaturePair["mode"]): FeaturePair {
  return {
    feature,
    displayName: feature === "feature-one" ? "Feature One" : "Feature Two",
    projectRoot: path.resolve(feature),
    mode,
    status: "idle",
    autoRound: mode === "auto" ? 1 : 0,
    autoRoundLimit: null,
    pmSeeded: true,
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

function checkpoint(id: string, sequence: number, message: string, source: PendingReview["source"] = "stop"): PendingReview {
  return {
    id,
    sequence,
    claudeMessage: message,
    source,
    createdAt: `2026-01-01T00:00:0${sequence}.000Z`
  };
}

test("session reports retain checkpoints across modes and update entries in place", () => {
  const ledger = new SessionReportLedger("2026-01-01T00:00:00.000Z");
  const manual = pair("feature-one", "manual");
  const first = checkpoint("checkpoint-1", 1, "Claude manual handoff");
  ledger.start(manual, first);
  ledger.update(manual.feature, first.id, { codexTurnId: "turn-1" });
  ledger.complete(manual.feature, first.id, "Manual review body", {
    status: "waiting-user"
  }, "2026-01-01T00:00:06.000Z");
  ledger.update(manual.feature, first.id, {
    status: "published",
    delivery: "stop-hook",
    resolvedAt: "2026-01-01T00:00:07.000Z"
  });

  const automatic = pair("feature-one", "auto");
  const second = checkpoint("checkpoint-2", 2, "Claude automatic handoff", "pull-queue");
  ledger.start(automatic, second);
  ledger.complete(automatic.feature, second.id, "Automatic review body", {
    codexTurnId: "turn-2",
    decision: "revise",
    status: "revision-queued",
    delivery: "next-prompt",
    resolvedAt: "2026-01-01T00:00:09.000Z"
  }, "2026-01-01T00:00:08.000Z");

  const third = checkpoint("checkpoint-3", 3, "Claude interim handoff");
  ledger.start(automatic, third);
  ledger.complete(automatic.feature, third.id, "Deferred while tests finish.", {
    codexTurnId: "turn-3",
    status: "deferred",
    autoRound: undefined,
    resolvedAt: "2026-01-01T00:00:12.000Z"
  }, "2026-01-01T00:00:11.000Z");

  const workstreamContext = "Implement checkout retries\n\nKeep the private rollout details intact.";
  const report = ledger.render("feature-one", "Feature One", false, workstreamContext);
  assert.match(report, /Review session report - Feature One/);
  assert.match(report, /Subject: Implement checkout retries/);
  assert.doesNotMatch(report, /private rollout details/);
  assert.match(report, /Checkpoints: 3/);
  assert.match(report, /Checkpoint #1 - published/);
  assert.match(report, /Mode: manual/);
  assert.match(report, /Checkpoint #2 - revision-queued/);
  assert.match(report, /Checkpoint #3 - deferred/);
  assert.equal(report.match(/Unattended round:/g)?.length, 1);
  assert.match(report, /Mode: auto/);
  assert.match(report, /Source: pull-queue/);
  assert.match(report, /Unattended round: 2/);
  assert.match(report, /Total review time: 19\.0 seconds/);
  assert.ok(report.indexOf("Manual review body") < report.indexOf("Automatic review body"));
  assert.doesNotMatch(report, /Claude manual handoff|Claude automatic handoff/);
  assert.match(report, /--full/);

  const full = ledger.render("feature-one", "Feature One", true, workstreamContext);
  assert.match(full, /Initial request[\s\S]*Keep the private rollout details intact/);
  assert.match(full, /Claude manual handoff/);
  assert.match(full, /Claude automatic handoff/);
});

test("session reports show live pending and superseded checkpoints without leaking across features", () => {
  const ledger = new SessionReportLedger("2026-01-01T00:00:00.000Z");
  const firstPair = pair("feature-one", "once");
  const first = checkpoint("checkpoint-1", 1, "First handoff");
  const second = checkpoint("checkpoint-2", 2, "Second handoff");
  ledger.start(firstPair, first);
  assert.match(ledger.render(firstPair.feature, firstPair.displayName), /Checkpoint #1 - reviewing/);
  ledger.update(firstPair.feature, first.id, {
    status: "superseded",
    supersededBy: { id: second.id, sequence: second.sequence },
    resolvedAt: "2026-01-01T00:00:02.000Z"
  });
  ledger.start(firstPair, second);

  const firstReport = ledger.render(firstPair.feature, firstPair.displayName);
  assert.match(firstReport, /Checkpoint #1 - superseded/);
  assert.match(firstReport, /Superseded by: #2 \(checkpoint-2\)/);
  assert.match(firstReport, /Checkpoint #2 - reviewing/);

  const secondPair = pair("feature-two", "manual");
  const secondReport = ledger.render(secondPair.feature, secondPair.displayName);
  assert.match(secondReport, /Subject: Not captured yet/);
  assert.match(secondReport, /Checkpoints: 0/);
  assert.match(secondReport, /No checkpoints have been created/);
  assert.doesNotMatch(secondReport, /checkpoint-1|checkpoint-2/);
});
