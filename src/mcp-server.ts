import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { bridgeRequest } from "./bridge-client.js";

const server = new McpServer({ name: "claude-codex-review-bridge", version: "0.1.0" });

function result(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

server.registerTool("review_bridge_set_mode", {
  description: "Set the paired Claude/Codex bridge mode for a workstream.",
  inputSchema: z.object({ feature: z.string(), mode: z.enum(["off", "manual", "once", "auto"]) })
}, async ({ feature, mode }) => result(await bridgeRequest("/mode", { feature, mode })));

server.registerTool("review_bridge_status", {
  description: "Show bridge status and immutable session IDs for a workstream.",
  inputSchema: z.object({ feature: z.string() })
}, async ({ feature }) => result(await bridgeRequest("/status", { feature })));

server.registerTool("review_bridge_publish", {
  description: "Publish a completed Codex review for the exact latest checkpoint; reports whether it released a held Stop hook or queued delivery for Claude's next prompt.",
  inputSchema: z.object({ feature: z.string(), checkpointId: z.string(), feedback: z.string().optional() })
}, async ({ feature, checkpointId, feedback }) => result(await bridgeRequest("/publish", { feature, checkpointId, feedback })));

server.registerTool("review_bridge_force_publish", {
  description: "Explicit recovery operation that queues an unheld interactive Codex review for Claude's next prompt. Requires manual mode, idle status, no pending checkpoint, and the paired Codex thread ID.",
  inputSchema: z.object({ feature: z.string(), codexThreadId: z.string(), feedback: z.string().min(1) })
}, async ({ feature, codexThreadId, feedback }) => result(await bridgeRequest("/force-publish", { feature, codexThreadId, feedback })));

server.registerTool("review_bridge_cancel", {
  description: "Cancel the exact latest held checkpoint and let Claude stop without feedback.",
  inputSchema: z.object({ feature: z.string(), checkpointId: z.string() })
}, async ({ feature, checkpointId }) => result(await bridgeRequest("/cancel", { feature, checkpointId })));

await serveStdio(() => server);
