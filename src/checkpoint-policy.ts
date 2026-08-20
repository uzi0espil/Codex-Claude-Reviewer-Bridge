import { FeaturePair, PendingReview } from "./types.js";

export function createCheckpoint(
  pair: FeaturePair,
  id: string,
  claudeMessage: string,
  createdAt = new Date().toISOString()
): PendingReview {
  const previousSequence = Math.max(pair.checkpointSequence ?? 0, pair.pending?.sequence ?? 0);
  const sequence = previousSequence + 1;
  return {
    id,
    sequence,
    supersedes: pair.pending ? { id: pair.pending.id, sequence: pair.pending.sequence } : undefined,
    claudeMessage,
    createdAt
  };
}

export function checkpointDecisionError(
  pair: FeaturePair,
  checkpointId: unknown,
  requireCompletedReview: boolean
): string | undefined {
  if (!pair.pending) return "there is no pending checkpoint";
  if (!checkpointId) return `checkpointId is required; the latest checkpoint is ${pair.pending.id}`;
  if (String(checkpointId) !== pair.pending.id) {
    return `checkpoint ${String(checkpointId)} was superseded; the latest checkpoint is ${pair.pending.id}`;
  }
  if (requireCompletedReview && (pair.status !== "waiting-user" || !pair.pending.codexResponse)) {
    const label = pair.pending.sequence ? ` #${pair.pending.sequence}` : "";
    return `the latest checkpoint${label} is still under review`;
  }
  return undefined;
}

export function forcePublishError(
  pair: FeaturePair,
  codexThreadId: unknown,
  feedback: unknown
): string | undefined {
  if (pair.pending) return "a checkpoint is pending; use the normal checkpoint-bound publish or cancel flow";
  if (pair.queuedClaudeContext) return "feedback is already queued for Claude's next prompt";
  if (pair.mode !== "manual") return "force publication requires bridge mode manual";
  if (pair.status !== "idle") return `force publication requires status idle; current status is ${pair.status}`;
  if (!pair.codexThreadId || String(codexThreadId ?? "") !== pair.codexThreadId) {
    return "the supplied Codex thread does not match the paired feature thread";
  }
  if (!String(feedback ?? "").trim()) return "explicit feedback is required for force publication";
  return undefined;
}
