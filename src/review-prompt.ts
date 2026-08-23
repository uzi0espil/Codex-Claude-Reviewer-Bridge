import crypto from "node:crypto";
import fs from "node:fs";
import { localReviewPolicyPath, reviewPolicyPath } from "./paths.js";
import { FeaturePair, PendingReview } from "./types.js";

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

export interface ReviewPolicySnapshot {
  content: string;
  sha256: string;
}

export function reviewPolicySnapshot(content = readReviewPolicy()): ReviewPolicySnapshot {
  return {
    content,
    sha256: crypto.createHash("sha256").update(content, "utf8").digest("hex")
  };
}

export function buildReviewPolicySeed(pair: FeaturePair, policy: ReviewPolicySnapshot): string {
  return [
    `[Review policy for bridge workstream: ${pair.displayName}]`,
    `Policy SHA-256: ${policy.sha256}`,
    "This policy governs every subsequent bridge-injected review checkpoint and Claude question advisory in this Codex thread until a later policy update is injected. Apply it without requiring the full policy to be repeated in each checkpoint.",
    "",
    policy.content
  ].join("\n");
}

export function composeReviewPolicy(baseline: string, local: string): string {
  const base = baseline.trim() || fallbackPolicy;
  const overlay = local.trim();
  if (!overlay) return base;
  return `${base}\n\n## Application-specific review policy\n\n${overlay}`;
}

export function buildReviewPrompt(pair: FeaturePair, message: string, checkpoint?: PendingReview): string {
  const autoContract = pair.mode === "auto"
    ? [
        "This is an automatic review turn. After completing the assessment, call `review_bridge_record_auto_decision` exactly once with this feature, the exact checkpoint ID above, and one decision: `pass`, `pass_continue`, `revise`, or `needs_user`.",
        "Use `pass` only when the reviewed work and the user's authorized workflow are complete. Use `pass_continue` when this review gate is clean but Claude still has a concrete next action that the user already authorized; include only that next action in `continuation`. Never use it to create authorization, broaden scope, or infer permission for an external mutation.",
        "Use `revise` only for actionable material defects. Use `needs_user` for a choice, unavailable required validation, unclear authorization, ambiguity that should not be decided autonomously, or when the unattended feedback limit is exhausted.",
        "Then give the user a concise, normal Markdown response; never emit JSON. For `revise`, make that response the complete actionable feedback that Claude should receive. For `needs_user`, explain the decision required. For `pass` or `pass_continue`, make it a compact cycle report covering what Claude completed, what Codex advised during the cycle, validation performed, residual risks, and—when continuing—the next gate. The report is for the user; the bridge sends Claude only the separate continuation field."
      ].join("\n")
    : "Give the user a concise review with findings first. The user will decide whether and what to send back to Claude.";
  return [
    `[Review bridge checkpoint: ${pair.displayName}]`,
    checkpoint ? `Checkpoint: #${checkpoint.sequence ?? "?"} (${checkpoint.id})` : undefined,
    checkpoint?.supersedes
      ? `Supersession notice: this checkpoint supersedes unpublished checkpoint #${checkpoint.supersedes.sequence ?? "?"} (${checkpoint.supersedes.id}). Treat the earlier review as obsolete and reassess the latest handoff and current worktree.`
      : undefined,
    `Claude session: ${pair.claudeSessionId ?? "unknown"}`,
    `Bridge mode: ${pair.mode}; unattended feedback round: ${pair.autoRound}/3.`,
    "This bridge-injected turn is governed by the review policy already established in this Codex thread. Independently verify Claude's handoff against the current worktree, repository guidance, architecture and specification artifacts, code, tests, and diffs. Use live web research when current external facts materially affect the assessment. This turn is strictly read-only: do not edit files, apply patches, commit, publish, or approve external actions.",
    autoContract,
    "",
    "Latest Claude message:",
    message
  ].filter((line): line is string => line !== undefined).join("\n");
}
