import { randomUUID } from "node:crypto";
import { CapturedClaudeMessage, FeaturePair, PulledReview } from "./types.js";

export function captureClaudeMessage(
  claudeSessionId: string,
  message: string,
  capturedAt = new Date().toISOString(),
  id: string = randomUUID()
): CapturedClaudeMessage {
  return {
    id,
    claudeSessionId,
    message,
    capturedAt
  };
}

export function pullReviewError(pair: FeaturePair): string | undefined {
  if (!pair.capturedClaudeMessage) return "there is no Claude handoff captured while the bridge was off";
  if (pair.pulledReview) return "a pulled review is already queued or active";
  if (pair.capturedClaudeMessage.reviewRequestedAt) {
    return pair.capturedClaudeMessage.reviewedAt
      ? "the latest captured Claude handoff has already been reviewed for the user"
      : "a review of the latest captured Claude handoff is already queued or active";
  }
  if (pair.pending) return "a checkpoint is already pending; resolve it before pulling a review-only advisory";
  if (pair.queuedClaudeContext) return "feedback is already queued for Claude's next prompt";
  return undefined;
}

export function pullQueueError(pair: FeaturePair): string | undefined {
  if (!pair.capturedClaudeMessage) return "there is no Claude handoff captured while the bridge was off";
  if (pair.mode === "off") return "pull-queue requires bridge mode manual, once, or auto";
  if (pair.capturedClaudeMessage.queueRequestedAt) {
    return "the latest captured Claude handoff has already been queued for checkpoint review";
  }
  if (pair.pending) return "a checkpoint is already pending";
  if (pair.queuedClaudeContext) return "feedback is already queued for Claude's next prompt";
  if (pair.pulledReview) return "a review-only advisory is queued or active; wait for it to finish before queueing the handoff";
  return undefined;
}

export function createPulledReview(
  captured: CapturedClaudeMessage,
  createdAt = new Date().toISOString(),
  id: string = randomUUID()
): PulledReview {
  return {
    id,
    capturedMessageId: captured.id,
    claudeSessionId: captured.claudeSessionId,
    claudeMessage: captured.message,
    createdAt
  };
}
