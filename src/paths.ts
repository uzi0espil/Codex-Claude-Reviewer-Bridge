import path from "node:path";
import { fileURLToPath } from "node:url";

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
export const reviewerRoot = path.resolve(sourceDirectory, "..");
export const runtimeDirectory = path.join(reviewerRoot, "runtime");
export const statePath = path.join(runtimeDirectory, "state.json");
export const endpointPath = path.join(runtimeDirectory, "endpoint.json");
export const logPath = path.join(runtimeDirectory, "bridge.log");
export const reviewPolicyPath = path.join(reviewerRoot, "review-policy.md");
export const localReviewPolicyPath = path.join(reviewerRoot, "review-policy.local.md");

export function featureKey(value: string): string {
  const key = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!key) throw new Error("Feature name must contain at least one letter or number.");
  return key;
}
