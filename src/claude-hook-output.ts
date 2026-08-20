export type StopHookResult = { kind: "allow" } | { kind: "feedback"; text: string };

export function stopHookOutput(result: StopHookResult): Record<string, unknown> {
  if (result.kind === "feedback" && result.text.trim()) {
    return {
      decision: "block",
      reason: result.text,
      systemMessage: "Reviewer Agent's review received; Claude is now challenging or adapting it."
    };
  }
  return {};
}
