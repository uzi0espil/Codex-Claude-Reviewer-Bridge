import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { claudeTranscriptPaths } from "./claude-session.js";
import { FeaturePair } from "./types.js";

export const channelName = "review-bridge-channel";

export function channelTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function channelReceiptRecorded(pair: FeaturePair, transcriptPath?: string): Promise<boolean> {
  const attempt = pair.claudeChannelAttempt;
  if (!attempt || pair.claudeSessionId !== attempt.sessionId) return false;
  const candidates = claudeTranscriptPaths(pair);
  // Use only the known transcript locations for this pair.
  if (transcriptPath) {
    const supplied = path.resolve(transcriptPath);
    candidates.sort((left, right) => Number(right === supplied) - Number(left === supplied));
  }
  const attribute = `receipt_id="${attempt.receiptId}"`;
  for (const filename of candidates) {
    try {
      const handle = await fs.open(filename, "r");
      const stream = handle.createReadStream();
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      try {
        // Large tool results after the inbound event can bury its receipt far
        // before the tail by the time the next Stop runs.
        for await (const line of lines) {
          if (!line.includes(attempt.receiptId)) continue;
          let record;
          try { record = JSON.parse(line); } catch { continue; }
          const content = record.message?.content;
          if (record.sessionId === attempt.sessionId && record.type === "user" && record.isMeta === true &&
              record.origin?.kind === "channel" && record.origin.server === channelName &&
              typeof content === "string" && content.startsWith(`<channel source="${channelName}" `) &&
              content.split("\n", 1)[0].includes(attribute)) return true;
        }
      } finally {
        lines.close();
        stream.destroy();
        await handle.close();
      }
    } catch { /* An unreadable transcript cannot acknowledge delivery. */ }
  }
  return false;
}
