import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { bridgeRequest } from "./bridge-client.js";
import { writePolicyFile } from "./policy-store.js";
import { bridgeVersion } from "./version.js";
import { autoRoundLimitError } from "./mode-policy.js";

const server = new McpServer({ name: "claude-codex-review-bridge", version: bridgeVersion });

function result(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

const setModeInputSchema = z.object({
  feature: z.string(),
  mode: z.enum(["off", "manual", "once", "auto"]),
  roundLimit: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional()
}).superRefine(({ mode, roundLimit }, context) => {
  const error = autoRoundLimitError(mode, roundLimit);
  if (error) context.addIssue({ code: "custom", message: error, path: ["roundLimit"] });
});

server.registerTool("review_bridge_set_mode", {
  description: "Set the paired Claude/Codex bridge mode for a workstream. In auto mode, omit roundLimit for unlimited unattended deliveries or provide a positive integer for a per-cycle bound.",
  inputSchema: setModeInputSchema
}, async ({ feature, mode, roundLimit }) => result(await bridgeRequest("/mode", { feature, mode, roundLimit })));

server.registerTool("review_bridge_status", {
  description: "Show bridge status and immutable session IDs for a workstream.",
  inputSchema: z.object({ feature: z.string() })
}, async ({ feature }) => result(await bridgeRequest("/status", { feature })));

server.registerTool("review_bridge_pull_review", {
  description: "Start a one-off read-only Codex advisory for the latest Claude handoff captured while the bridge was off. The result is shown only to the user and cannot be published or delivered to Claude.",
  inputSchema: z.object({ feature: z.string() })
}, async ({ feature }) => result(await bridgeRequest("/pull-review", { feature })));

server.registerTool("review_bridge_pull_queue", {
  description: "Create an unheld checkpoint from the latest Claude handoff captured while the bridge was off. Requires manual, once, or auto mode; any resulting feedback is delivered on Claude's next user prompt.",
  inputSchema: z.object({ feature: z.string() })
}, async ({ feature }) => result(await bridgeRequest("/pull-queue", { feature })));

server.registerTool("review_bridge_record_auto_decision", {
  description: "Record the control decision for the exact automatic review checkpoint. pass_continue requires a concrete next action already authorized by the user. This does not itself release Claude or modify project files. Call exactly once near the end of an injected auto-review turn, then return a normal Markdown response.",
  inputSchema: z.object({
    feature: z.string(),
    checkpointId: z.string(),
    decision: z.enum(["pass", "pass_continue", "revise", "needs_user"]),
    continuation: z.string().max(2_000).optional()
  })
}, async ({ feature, checkpointId, decision, continuation }) => result(await bridgeRequest("/auto-decision", {
  feature,
  checkpointId,
  decision,
  continuation
})));

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

server.registerTool("review_bridge_write_policy", {
  description: "Write the approved application-specific review policy to the one fixed local policy file. The caller cannot choose a path. Use null expectedSha256 only when no policy exists; otherwise pass the exact SHA-256 observed before presenting the update diff.",
  inputSchema: z.object({
    content: z.string().min(1),
    expectedSha256: z.string().regex(/^[a-fA-F0-9]{64}$/).nullable()
  })
}, async ({ content, expectedSha256 }) => result(writePolicyFile(content, expectedSha256)));

await serveStdio(() => server);
