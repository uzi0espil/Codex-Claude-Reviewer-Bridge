import { AutoCycleReceipt, AutoReviewDecision, FeaturePair } from "./types.js";

export type AutoReviewResolution =
  | { kind: "pass"; reviewRounds: number; summary: string }
  | { kind: "continue"; reviewRounds: number; summary: string; continuation: string }
  | { kind: "revise"; feedback: string }
  | { kind: "waiting-user"; response: string; reason: "needs-user" | "round-limit" | "missing-decision" | "missing-continuation" };

export const maxAutoFeedbackRounds = 3;
export const maxAutoContinuationLength = 2_000;

export function autoDecisionError(
  pair: FeaturePair,
  checkpointId: unknown,
  decision: unknown,
  continuation?: unknown
): string | undefined {
  if (pair.mode !== "auto") return "automatic decisions require bridge mode auto";
  if (pair.status !== "reviewing" || !pair.pending) return "there is no automatic review in progress";
  if (!checkpointId || String(checkpointId) !== pair.pending.id) {
    return `checkpoint ${String(checkpointId ?? "")} is not the active automatic checkpoint ${pair.pending.id}`;
  }
  if (decision !== "pass" && decision !== "pass_continue" && decision !== "revise" && decision !== "needs_user") {
    return "invalid automatic decision";
  }
  if (pair.pending.autoDecision) return `automatic decision already recorded as ${pair.pending.autoDecision}`;
  const nextAction = typeof continuation === "string" ? continuation.trim() : "";
  if (decision === "pass_continue" && !nextAction) {
    return "pass_continue requires the concrete, already-authorized next action";
  }
  if (decision === "pass_continue" && nextAction.length > maxAutoContinuationLength) {
    return `pass_continue continuation exceeds ${maxAutoContinuationLength} characters`;
  }
  if (decision !== "pass_continue" && nextAction) {
    return "continuation is only valid with pass_continue";
  }
  return undefined;
}

export function resolveAutoReview(pair: FeaturePair, response: string): AutoReviewResolution {
  const text = response.trim();
  const decision = pair.pending?.autoDecision;
  const continuation = pair.pending?.autoContinuation?.trim();
  if (!decision) return { kind: "waiting-user", response: text, reason: "missing-decision" };
  if (decision === "pass") {
    return { kind: "pass", reviewRounds: pair.autoRound + 1, summary: text };
  }
  if (decision === "pass_continue") {
    if (!continuation) {
      return { kind: "waiting-user", response: text, reason: "missing-continuation" };
    }
    if (pair.autoRound < maxAutoFeedbackRounds) {
      return {
        kind: "continue",
        reviewRounds: pair.autoRound + 1,
        summary: text,
        continuation
      };
    }
  }
  if (decision === "revise" && pair.autoRound < maxAutoFeedbackRounds) return { kind: "revise", feedback: text };
  return {
    kind: "waiting-user",
    response: text,
    reason: decision === "needs_user" ? "needs-user" : "round-limit"
  };
}

export function buildAutoContinuation(continuation: string): string {
  return [
    "Independent review gate passed.",
    "",
    "Continue the concrete next action that the user already authorized:",
    "",
    continuation.trim(),
    "",
    "Challenge or adapt this instruction against the current project evidence; do not comply mechanically or expand its scope. This message is not new authorization. If the prerequisite, safety, or authorization is no longer clear, stop and ask the user."
  ].join("\n");
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
