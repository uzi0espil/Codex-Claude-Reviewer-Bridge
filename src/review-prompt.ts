import crypto from "node:crypto";
import fs from "node:fs";
import { localReviewPolicyPath, reviewPolicyPath } from "./paths.js";
import { FeaturePair, PendingReview, PulledReview } from "./types.js";

const fallbackPolicy = [
  "Review the latest handoff as an independent, evidence-driven reviewer.",
  "Inspect the current worktree, repository guidance, architecture and specification artifacts, code, tests, and diffs instead of trusting the handoff alone.",
  "Use live web research when current external facts materially affect the assessment.",
  "This injected review turn is strictly read-only: do not edit files, apply patches, commit, publish, or approve external actions."
].join("\n");

export function readReviewPolicy(): string {
  const baseline = fs.existsSync(reviewPolicyPath)
    ? fs.readFileSync(reviewPolicyPath, "utf8").trim()
    : fallbackPolicy;
  const local = fs.existsSync(localReviewPolicyPath)
    ? fs.readFileSync(localReviewPolicyPath, "utf8").trim()
    : "";
  return composeReviewPolicy(baseline, local);
}

const bridgeProtocol = [
  "## Stable bridge protocol",
  "",
  "For every bridge-injected checkpoint:",
  "- Act as an independent, evidence-driven reviewer. Treat the current worktree as authoritative and Claude's handoff as a claim to verify against repository guidance, architecture and specification artifacts, code, tests, and diffs. Use live web research when current external facts materially affect the assessment.",
  "- The turn is strictly read-only: do not edit files, apply patches, commit, publish, or approve external actions.",
  "- In manual or once mode, return concise findings-first Markdown. The user decides whether and what to publish to Claude.",
  "- In auto mode, call `review_bridge_record_auto_decision` exactly once after the assessment, using the exact feature and checkpoint supplied by the current checkpoint prompt. Choose `pass` only when the reviewed work and the user's authorized workflow are complete. Choose `pass_continue` only when this gate is clean and Claude has a concrete next action already authorized by the user; put only that action in `continuation`. Never create authorization, broaden scope, or infer permission for an external mutation. Choose `revise` only for actionable material defects. Choose `needs_user` for a user choice, unavailable required validation, unclear authorization, unresolved ambiguity, or an exhausted unattended limit.",
  "- After the auto decision call, return concise normal Markdown, never JSON. For `revise`, return the complete feedback Claude should receive. For `needs_user`, explain the decision required. For `pass` or `pass_continue`, report only the current gate's outcome, validation, residual risks, and—when continuing—the next gate. Do not generate a cycle recap: the bridge assembles cumulative reports out of band. The bridge sends Claude only revision feedback or the separate continuation, never the Codex report.",
  "",
  "For a Claude question advisory, inspect the evidence and explain material tradeoffs, assumptions, uncertainty, and a recommendation when supported. Do not publish or answer Claude automatically; the user personally submits the final answer in Claude.",
  "For a pulled review-only advisory, give the user a concise findings-first assessment. Do not record an automatic decision, create publishable feedback, or deliver anything to Claude."
].join("\n");

export interface ReviewContextSnapshot {
  content: string;
  sha256: string;
}

export function reviewContextSnapshot(policy = readReviewPolicy()): ReviewContextSnapshot {
  const content = `${bridgeProtocol}\n\n## Review policy\n\n${policy}`;
  return {
    content,
    sha256: crypto.createHash("sha256").update(content, "utf8").digest("hex")
  };
}

export function buildReviewContextSeed(pair: FeaturePair, context: ReviewContextSnapshot): string {
  return [
    `[Review bridge context for workstream: ${pair.displayName}]`,
    `Context SHA-256: ${context.sha256}`,
    "This protocol and policy govern every subsequent bridge-injected checkpoint, Claude question advisory, and pulled review-only advisory in this Codex thread until an updated context is injected. Apply them without requiring the stable instructions to be repeated in each turn.",
    "",
    context.content
  ].join("\n");
}

export function compactedPolicyReminder(pair: FeaturePair): string | undefined {
  if (!pair.reviewContextCompacted) return undefined;
  return `Context maintenance: Codex compacted this thread. Before reviewing, re-read the baseline policy at ${reviewPolicyPath} and the optional application policy at ${localReviewPolicyPath}; do not assume the compacted summary preserved application-specific rules.`;
}

export function composeReviewPolicy(baseline: string, local: string): string {
  const base = baseline.trim() || fallbackPolicy;
  const overlay = local.trim();
  if (!overlay) return base;
  return `${base}\n\n## Application-specific review policy\n\n${overlay}`;
}

export function buildReviewPrompt(pair: FeaturePair, message: string, checkpoint?: PendingReview): string {
  const autoRoundLimit = pair.autoRoundLimit === null ? "unlimited" : String(pair.autoRoundLimit);
  const autoContract = pair.mode === "auto"
    ? [
      `Automatic control: after reviewing, call \`review_bridge_record_auto_decision\` exactly once for feature \`${pair.feature}\` and checkpoint \`${checkpoint?.id ?? "unknown"}\`; then return concise Markdown.`,
      "Decision boundary: pass = authorized workflow complete; pass_continue = clean gate plus exactly one already-authorized next action; revise = material defect; needs_user = choice, unavailable validation, ambiguity, or uncertain authorization. Never broaden authorization."
    ].join("\n")
    : "Return concise findings-first Markdown; the user controls publication.";
  return [
    `[Review bridge checkpoint: ${pair.displayName}]`,
    checkpoint ? `Checkpoint: #${checkpoint.sequence ?? "?"} (${checkpoint.id})` : undefined,
    checkpoint?.supersedes
      ? `Supersession notice: this checkpoint supersedes unpublished checkpoint #${checkpoint.supersedes.sequence ?? "?"} (${checkpoint.supersedes.id}). Treat the earlier review as obsolete and reassess the latest handoff and current worktree.`
      : undefined,
    `Claude session: ${pair.claudeSessionId ?? "unknown"}`,
    `Bridge mode: ${pair.mode}; unattended feedback/continuation deliveries: ${pair.autoRound}/${autoRoundLimit}.`,
    "Follow the bridge protocol and review policy established in this thread. This injected turn remains strictly read-only.",
    compactedPolicyReminder(pair),
    autoContract,
    "",
    "Latest Claude message:",
    message
  ].filter((line): line is string => line !== undefined).join("\n");
}

export function buildPulledReviewPrompt(pair: FeaturePair, review: PulledReview): string {
  return [
    `[Pulled Claude review for user: ${pair.displayName}]`,
    `Captured message: ${review.capturedMessageId}`,
    `Claude session: ${review.claudeSessionId}`,
    `Bridge mode: ${pair.mode}.`,
    "Follow the bridge protocol and review policy established in this thread. This injected turn remains strictly read-only.",
    compactedPolicyReminder(pair),
    "This is a review-only advisory for the user. Return concise findings-first Markdown. Do not call the automatic-decision tool, create a checkpoint decision, publish feedback, or queue anything for Claude.",
    "",
    "Latest captured Claude message:",
    review.claudeMessage
  ].filter((line): line is string => line !== undefined).join("\n");
}
