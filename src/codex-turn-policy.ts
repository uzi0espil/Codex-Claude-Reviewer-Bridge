export class CodexThreadBusyError extends Error {
  constructor(threadId: string) {
    super(`Codex thread ${threadId} already has an active turn.`);
    this.name = "CodexThreadBusyError";
  }
}

export function isCodexThreadBusyError(error: unknown): boolean {
  if (error instanceof CodexThreadBusyError) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /active turn|turn[^\n]*(?:in progress|already running)|thread[^\n]*busy/i.test(message);
}
