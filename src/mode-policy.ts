import { BridgeMode } from "./types.js";

export function modeAfterUserDecision(mode: BridgeMode): BridgeMode {
  return mode === "manual" ? "manual" : "off";
}
