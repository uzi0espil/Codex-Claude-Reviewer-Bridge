import fs from "node:fs";
import { localConfigPath } from "./paths.js";
import { DefaultBridgeMode } from "./types.js";

const defaultModes: DefaultBridgeMode[] = ["off", "manual", "auto"];

export function readInstanceDefaultMode(filename = localConfigPath): DefaultBridgeMode {
  const parsed = JSON.parse(fs.readFileSync(filename, "utf8")) as { defaultMode?: unknown };
  if (parsed.defaultMode === undefined) return "manual";
  if (defaultModes.includes(parsed.defaultMode as DefaultBridgeMode)) {
    return parsed.defaultMode as DefaultBridgeMode;
  }
  throw new Error("bridge.local.json defaultMode must be off, manual, or auto.");
}
