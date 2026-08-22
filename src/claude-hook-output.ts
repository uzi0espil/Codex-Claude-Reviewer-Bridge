export type StopHookResult =
  | { kind: "allow"; systemMessage?: string }
  | { kind: "feedback"; text: string };

export function stopHookOutput(result: StopHookResult): Record<string, unknown> {
  if (result.kind === "feedback" && result.text.trim()) {
    return {
      decision: "block",
      reason: result.text,
      systemMessage: "Reviewer Agent's review received; Claude is now challenging or adapting it."
    };
  }
  if (result.kind === "allow" && result.systemMessage?.trim()) {
    return { systemMessage: result.systemMessage.trim() };
  }
  return {};
}
