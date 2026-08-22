import { AutoReviewDecision, FeaturePair } from "./types.js";

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

export function buildAutoCycleMessage(summary: string, reviewRounds: number): string {
  const heading = `Automatic review cycle complete — passed after ${reviewRounds} review ${reviewRounds === 1 ? "round" : "rounds"}.`;
  const maximumLength = 9_500;
  const message = `${heading}\n\n${summary.trim()}`;
  if (message.length <= maximumLength) return message;
  return `${message.slice(0, maximumLength - 72).trimEnd()}\n\n[Cycle report shortened for terminal display.]`;
}
