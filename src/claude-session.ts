import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { FeaturePair } from "./types.js";

export const claudeSessionLifecycleVersion = 2;

// Hooks can fail while Claude continues and persists its conversation. In a
// managed worktree Claude may store that transcript under the original repo.
export async function hasPersistedClaudeConversation(
  pair: FeaturePair,
  configDirectory = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude")
): Promise<boolean> {
  const sessionId = pair.claudeSessionId;
  if (!sessionId || !/^[a-zA-Z0-9-]+$/.test(sessionId)) return false;
  const roots = new Set([pair.projectRoot, pair.repositoryRoot ?? pair.projectRoot]);
  for (const root of roots) {
    const project = root.replace(/[^a-zA-Z0-9]/g, "-");
    const filename = path.join(configDirectory, "projects", project, `${sessionId}.jsonl`);
    let handle;
    try {
      handle = await fs.promises.open(filename, "r");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const stream = handle.createReadStream();
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        let record;
        try { record = JSON.parse(line); } catch { continue; }
        if (record?.sessionId === sessionId && !record.isSidechain && !record.isMeta &&
            ((record.type === "user" && record.message?.role === "user") ||
             (record.type === "assistant" && record.message?.role === "assistant"))) return true;
      }
    } finally {
      lines.close();
      stream.destroy();
      await handle.close();
    }
  }
  return false;
}

function hasDurableConversationEvidence(pair: FeaturePair): boolean {
  return Boolean(
    pair.pmSeeded ||
    pair.initialPrompt ||
    pair.checkpointSequence ||
    pair.pending ||
    pair.lastCodexResponse ||
    pair.questionAdvisoryQueue?.length ||
    pair.activeQuestionAdvisory
  );
}

export function migrateClaudeSessionLifecycle(pair: FeaturePair): void {
  if (pair.claudeSessionLifecycleVersion === claudeSessionLifecycleVersion) return;
  pair.claudeSessionStarted = hasDurableConversationEvidence(pair);
  pair.claudeSessionLifecycleVersion = claudeSessionLifecycleVersion;
}

export function recordClaudeSession(
  pair: FeaturePair,
  sessionId: string,
  conversationPersisted: boolean
): void {
  pair.claudeSessionId = sessionId;
  if (conversationPersisted) pair.claudeSessionStarted = true;
  pair.claudeSessionLifecycleVersion = claudeSessionLifecycleVersion;
}
