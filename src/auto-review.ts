import { AutoCycleReceipt, AutoReviewDecision, FeaturePair } from "./types.js";

export type AutoReviewResolution =
  | { kind: "pass"; reviewRounds: number; summary: string }
  | { kind: "revise"; feedback: string }
  | { kind: "waiting-user"; response: string; reason: "needs-user" | "round-limit" | "missing-decision" };

export function autoDecisionError(
  pair: FeaturePair,
  checkpointId: unknown,
  decision: unknown
): string | undefined {
  if (pair.mode !== "auto") return "automatic decisions require bridge mode auto";
  if (pair.status !== "reviewing" || !pair.pending) return "there is no automatic review in progress";
  if (!checkpointId || String(checkpointId) !== pair.pending.id) {
    return `checkpoint ${String(checkpointId ?? "")} is not the active automatic checkpoint ${pair.pending.id}`;
  }
  if (decision !== "pass" && decision !== "revise" && decision !== "needs_user") {
    return "invalid automatic decision";
  }
  if (pair.pending.autoDecision) return `automatic decision already recorded as ${pair.pending.autoDecision}`;
  return undefined;
}

export function resolveAutoReview(pair: FeaturePair, response: string): AutoReviewResolution {
  const text = response.trim();
  const decision = pair.pending?.autoDecision;
  if (!decision) return { kind: "waiting-user", response: text, reason: "missing-decision" };
  if (decision === "pass") {
    return { kind: "pass", reviewRounds: pair.autoRound + 1, summary: text };
  }
  if (decision === "revise" && pair.autoRound < 3) return { kind: "revise", feedback: text };
  return {
    kind: "waiting-user",
    response: text,
    reason: decision === "needs_user" ? "needs-user" : "round-limit"
  };
}

function singleLineHeadline(response: string): string {
  const firstLine = response.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "Review completed.";
  const plain = firstLine.replace(/^#{1,6}\s+/, "").replace(/^[-*+]\s+/, "").replace(/\s+/g, " ");
  return plain.length <= 160 ? plain : `${plain.slice(0, 157).trimEnd()}...`;
}

export function createAutoCycleReceipt(
  pair: FeaturePair,
  codexTurnId: string,
  outcome: AutoCycleReceipt["outcome"],
  response: string,
  completedAt = new Date().toISOString()
): AutoCycleReceipt {
  if (!pair.pending) throw new Error("Cannot create an automatic cycle receipt without a pending checkpoint.");
  const startedAt = pair.pending.createdAt;
  const elapsed = Date.parse(completedAt) - Date.parse(startedAt);
  return {
    feature: pair.feature,
    checkpointId: pair.pending.id,
    checkpointSequence: pair.pending.sequence,
    codexTurnId,
    decision: pair.pending.autoDecision ?? "missing",
    outcome,
    reviewRound: pair.autoRound + 1,
    startedAt,
    completedAt,
    durationMs: Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0,
    headline: singleLineHeadline(response)
  };
}

export function formatAutoCycleReport(feature: string, receipt: AutoCycleReceipt, response: string): string {
  const checkpoint = receipt.checkpointSequence
    ? `#${receipt.checkpointSequence} (${receipt.checkpointId})`
    : receipt.checkpointId;
  return [
    `# Automatic review report — ${feature}`,
    "",
    `- Checkpoint: ${checkpoint}`,
    `- Codex turn: ${receipt.codexTurnId}`,
    `- Decision: ${receipt.decision}`,
    `- Outcome: ${receipt.outcome}`,
    `- Review round: ${receipt.reviewRound}`,
    `- Started: ${receipt.startedAt}`,
    `- Completed: ${receipt.completedAt}`,
    `- Duration: ${(receipt.durationMs / 1000).toFixed(1)} seconds`,
    "",
    "## Codex report",
    "",
    response.trim(),
    ""
  ].join("\n");
}

export function buildAutoCycleMessage(summary: string, receipt: AutoCycleReceipt): string {
  const checkpoint = receipt.checkpointSequence ? `#${receipt.checkpointSequence}` : receipt.checkpointId.slice(0, 8);
  const roundLabel = `${receipt.reviewRound} review ${receipt.reviewRound === 1 ? "round" : "rounds"}`;
  const heading = `Codex completed checkpoint ${checkpoint} in ${(receipt.durationMs / 1000).toFixed(1)}s — PASS after ${roundLabel}: ${receipt.headline} [report: just report ${receipt.feature}]`;
  const reportHint = receipt.reportPath
    ? `Out-of-band report: ${receipt.reportPath}`
    : "The out-of-band report could not be saved; this Stop message contains the complete report.";
  const maximumLength = 9_500;
  const message = `${heading}\n\n${summary.trim()}\n\n${reportHint}`;
  if (message.length <= maximumLength) return message;
  return `${message.slice(0, maximumLength - 72).trimEnd()}\n\n[Cycle report shortened for terminal display.]`;
}
