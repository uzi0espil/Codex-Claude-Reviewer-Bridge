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

export function readDesktopNotificationsEnabled(filename = localConfigPath): boolean {
  const parsed = JSON.parse(fs.readFileSync(filename, "utf8")) as { desktopNotifications?: unknown };
  if (parsed.desktopNotifications === undefined) return true;
  if (typeof parsed.desktopNotifications === "boolean") return parsed.desktopNotifications;
  throw new Error("bridge.local.json desktopNotifications must be true or false.");
}
