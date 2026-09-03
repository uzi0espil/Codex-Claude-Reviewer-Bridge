import { AutoReviewDecision, FeaturePair } from "./types.js";

export type AutoReviewResolution =
  | { kind: "pass"; reviewRounds: number; summary: string }
  | { kind: "continue"; reviewRounds: number; summary: string; continuation: string }
  | { kind: "revise"; feedback: string }
  | { kind: "waiting-user"; response: string; reason: "needs-user" | "round-limit" | "missing-decision" | "missing-continuation" };

export const maxAutoContinuationLength = 2_000;

function canDeliverUnattended(pair: FeaturePair): boolean {
  return pair.autoRoundLimit === null || pair.autoRound < pair.autoRoundLimit;
}

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
    if (canDeliverUnattended(pair)) {
      return {
        kind: "continue",
        reviewRounds: pair.autoRound + 1,
        summary: text,
        continuation
      };
    }
  }
  if (decision === "revise" && canDeliverUnattended(pair)) return { kind: "revise", feedback: text };
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

export function buildAutoCycleStatus(feature: string): string {
  return `Automatic review passed. Details remain in Codex and the live \`just report ${feature}\` session report.`;
}
