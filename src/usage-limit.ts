import { AppServerRpcError } from "./app-server.js";

// Codex 0.163.0 generated CodexErrorInfo schema: usageLimitExceeded is
// distinct from rateLimitExceeded. Do not infer quota exhaustion from HTTP 429.
export function isUsageLimit(error: unknown): boolean {
  const detail: any = error instanceof AppServerRpcError ? error.detail : error;
  return detail?.codexErrorInfo === "usageLimitExceeded"
    || detail?.data?.codexErrorInfo === "usageLimitExceeded";
}

// Verified account/rateLimits/read schema: seconds since epoch. Restrict to
// the default Codex bucket; another model's exhausted quota cannot wake this one.
export function usageResetAt(response: any, now = Date.now()): number | undefined {
  const limits = response?.rateLimits;
  if (!limits || (limits.limitId && limits.limitId !== "codex")) return undefined;
  const windows = [limits.primary, limits.secondary].filter((window) =>
    typeof window?.usedPercent === "number" && window.usedPercent >= 100);
  if (!windows.length || windows.some((window) => !Number.isFinite(window.resetsAt))) return undefined;
  const reset = Math.max(...windows.map((window) => window.resetsAt * 1000));
  return reset > now && reset <= 8.64e15 ? reset : undefined;
}

export function retryDeadline(reset: number | undefined, attempts: number, now = Date.now(), random = Math.random): number | undefined {
  if (attempts >= 5 || reset === undefined) return undefined;
  return Math.max(reset + 1000, now + Math.min(900_000, 60_000 * 2 ** attempts) * (1 + random() * 0.1));
}
