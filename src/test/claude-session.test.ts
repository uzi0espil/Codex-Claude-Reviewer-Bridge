import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { hasPersistedClaudeConversation } from "../claude-session.js";
import { FeaturePair } from "../types.js";

test("recovers conversation evidence from worktree or original repository after missed hooks", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "claude-resume-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const repositoryRoot = path.join(directory, "repo");
  const projectRoot = path.join(repositoryRoot, ".claude", "worktrees", "feature");
  const pair = { repositoryRoot, projectRoot, claudeSessionId: "session-1", claudeSessionStarted: false } as FeaturePair;
  assert.equal(await hasPersistedClaudeConversation(pair, directory), false);
  for (const root of [repositoryRoot, projectRoot]) {
    const project = path.join(directory, "projects", root.replace(/[^a-zA-Z0-9]/g, "-"));
    fs.mkdirSync(project, { recursive: true });
    const filename = path.join(project, "session-1.jsonl");
    const write = (record: unknown) => fs.writeFileSync(filename, JSON.stringify(record) + "\n");
    write({ type: "file-history-snapshot", sessionId: "session-1" });
    assert.equal(await hasPersistedClaudeConversation(pair, directory), false);
    write({ type: "user", sessionId: "other-session", message: { role: "user" } });
    assert.equal(await hasPersistedClaudeConversation(pair, directory), false);
    for (const flag of ["isSidechain", "isMeta"]) {
      write({ type: "user", sessionId: "session-1", [flag]: true, message: { role: "user" } });
      assert.equal(await hasPersistedClaudeConversation(pair, directory), false);
    }
    for (const role of ["user", "assistant"]) {
      write({ type: role, sessionId: "session-1", message: { role, content: "Persisted conversation" } });
      fs.appendFileSync(filename, '{"truncated":');
      assert.equal(await hasPersistedClaudeConversation(pair, directory), true);
    }
    fs.rmSync(filename);
  }
  assert.equal(await hasPersistedClaudeConversation({ ...pair, claudeSessionId: "../escape" }, directory), false);
});
