import { BridgeMode } from "./types.js";

export function autoRoundLimitError(mode: BridgeMode, roundLimit: unknown): string | undefined {
  if (roundLimit === undefined) return undefined;
  if (mode !== "auto") return "roundLimit is only valid with bridge mode auto";
  if (typeof roundLimit !== "number" || !Number.isSafeInteger(roundLimit) || roundLimit <= 0) {
    return "roundLimit must be a positive safe integer";
  }
  return undefined;
}

export function autoRoundLimitForMode(mode: BridgeMode, roundLimit: number | undefined): number | null {
  return mode === "auto" ? roundLimit ?? null : null;
}

export function modeAfterUserDecision(mode: BridgeMode): BridgeMode {
  return mode === "once" ? "off" : mode;
}

export function reviewTurnCompletion(status: string, response: string): "completed" | "interrupted" | "failed" {
  if (status === "interrupted") return "interrupted";
  return status === "completed" && Boolean(response.trim()) ? "completed" : "failed";
}
