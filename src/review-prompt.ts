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

export function composeReviewPolicy(baseline: string, local: string): string {
  const base = baseline.trim() || fallbackPolicy;
  const overlay = local.trim();
  if (!overlay) return base;
  return `${base}\n\n## Application-specific review policy\n\n${overlay}`;
}

export function buildReviewPrompt(pair: FeaturePair, message: string, checkpoint?: PendingReview): string {
  const autoContract = pair.mode === "auto"
    ? [
        "This is an automatic review turn. After completing the assessment, call `review_bridge_record_auto_decision` exactly once with this feature, the exact checkpoint ID above, and one decision: `pass`, `revise`, or `needs_user`.",
        "Use `revise` only for actionable material defects. Use `needs_user` for a choice, unavailable required validation, ambiguity that should not be decided autonomously, or when the automatic revision limit is exhausted.",
        "Then give the user a concise, normal Markdown response; never emit JSON. For `revise`, make that response the complete actionable feedback that Claude should receive. For `needs_user`, explain the decision required. For `pass`, make it a compact cycle report covering what Claude completed, what Codex advised during the cycle, validation performed, and residual risks."
      ].join("\n")
    : "Give the user a concise review with findings first. The user will decide whether and what to send back to Claude.";
  return [
    `[Review bridge checkpoint: ${pair.displayName}]`,
    checkpoint ? `Checkpoint: #${checkpoint.sequence ?? "?"} (${checkpoint.id})` : undefined,
    checkpoint?.supersedes
      ? `Supersession notice: this checkpoint supersedes unpublished checkpoint #${checkpoint.supersedes.sequence ?? "?"} (${checkpoint.supersedes.id}). Treat the earlier review as obsolete and reassess the latest handoff and current worktree.`
      : undefined,
    `Claude session: ${pair.claudeSessionId ?? "unknown"}`,
    `Bridge mode: ${pair.mode}; automatic revision round: ${pair.autoRound}/3.`,
    readReviewPolicy(),
    autoContract,
    "",
    "Latest Claude message:",
    message
  ].filter((line): line is string => line !== undefined).join("\n");
}
