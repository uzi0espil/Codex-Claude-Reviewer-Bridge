import { bridgeRequest } from "./bridge-client.js";
import { stopHookOutput, StopHookResult } from "./claude-hook-output.js";
import { ClaudeHookInput } from "./types.js";

async function stdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function output(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function main(): Promise<void> {
  const event = process.argv[2] ?? "";
  const feature = process.env.REVIEW_BRIDGE_FEATURE;
  if (!feature) return;
  const input = JSON.parse(await stdin()) as ClaudeHookInput;
  if (event === "session") {
    await bridgeRequest("/hook/session", { feature, input });
    output({});
    return;
  }
  if (event === "prompt") {
    const result = await bridgeRequest<{ additionalContext?: string; sessionTitle?: string }>("/hook/prompt", { feature, input });
    output({
      ...(result.additionalContext ? { systemMessage: "Queued agent review attached to this prompt for Claude to challenge or adapt." } : {}),
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        ...(result.additionalContext ? { additionalContext: result.additionalContext } : {}),
        ...(result.sessionTitle ? { sessionTitle: result.sessionTitle } : {})
      }
    });
    return;
  }
  if (event === "question") {
    await bridgeRequest("/hook/question", { feature, input });
    // No decision or updated input: Claude still presents and waits on its own question UI.
    output({});
    return;
  }
  if (event === "stop") {
    const result = await bridgeRequest<StopHookResult>("/hook/stop", { feature, input });
    output(stopHookOutput(result));
  }
}

void main().catch((error) => {
  // Hooks deliberately fail open when the private bridge is unavailable.
  process.stderr.write(`Review bridge unavailable; Claude continues without review: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 0;
});
