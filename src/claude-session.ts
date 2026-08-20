import { FeaturePair } from "./types.js";

export const claudeSessionLifecycleVersion = 2;

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
