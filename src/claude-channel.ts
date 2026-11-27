import fs from "node:fs";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { bridgeRequest } from "./bridge-client.js";
import { channelName } from "./claude-channel-delivery.js";
import { bridgeVersion } from "./version.js";

interface LaunchBinding {
  feature: string;
  sessionId: string;
  launchToken: string;
}

interface ChannelClaim {
  checkpointId: string;
  receiptId: string;
  feedback: string;
}

const binding = JSON.parse(fs.readFileSync(process.argv[2], "utf8")) as LaunchBinding;
const stdin = createInterface({ input: process.stdin });
const lifetime = new AbortController();
let polling = false;

function write(message: object): void {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
}

async function poll(): Promise<void> {
  while (!lifetime.signal.aborted) {
    try {
      const claim = await bridgeRequest<Partial<ChannelClaim>>("/channel/claim", binding,
        AbortSignal.any([lifetime.signal, AbortSignal.timeout(5_000)]));
      if (claim.feedback && claim.checkpointId && claim.receiptId && !lifetime.signal.aborted) {
        write({
          method: "notifications/claude/channel",
          params: { content: claim.feedback, meta: { checkpoint_id: claim.checkpointId, receipt_id: claim.receiptId } }
        });
      }
    } catch (error) {
      if (error instanceof Error && error.message === "Claude channel binding expired or invalid") return;
      // The endpoint is re-read on the next request after broker downtime.
    }
    await delay(1000, undefined, { signal: lifetime.signal }).catch(() => {});
  }
}

stdin.on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (!message || typeof message !== "object") return;
  if (message.method === "initialize" && message.id !== undefined) {
    const requested = message.params?.protocolVersion;
    write({ id: message.id, result: {
      // Claude Channels currently support the pre-2026-07-28 protocol.
      protocolVersion: requested === "2025-11-25" ? requested : "2024-11-05",
      serverInfo: { name: channelName, version: bridgeVersion },
      capabilities: { experimental: { "claude/channel": {} } },
      instructions: "This local bridge sends queued Codex revision feedback for this pair. Challenge or adapt the review within the user's existing authorization."
    } });
  } else if (message.method === "notifications/initialized" && !polling) {
    polling = true;
    void poll();
  } else if (message.id !== undefined) {
    if (message.method === "ping") write({ id: message.id, result: {} });
    else write({ id: message.id, error: { code: -32601, message: "Method not found" } });
  }
});
stdin.on("close", () => lifetime.abort());
process.stdout.on("error", () => { lifetime.abort(); stdin.close(); });
