import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { resolveActiveProjectRoot } from "../active-project-root.js";
import { validateManagedWorktree } from "../worktree.js";

function git(root: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return String(result.stdout).trim();
}

test("managed worktrees are authenticated against the bound repository", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "review-bridge-worktree-"));
  const repository = path.join(fixture, "repository");
  const worktree = path.join(fixture, "feature-worktree");
  try {
    fs.mkdirSync(repository);
    git(repository, "init");
    git(repository, "config", "user.email", "test@example.com");
    git(repository, "config", "user.name", "Test User");
    fs.writeFileSync(path.join(repository, "tracked.txt"), "initial\n", "utf8");
    git(repository, "add", "tracked.txt");
    git(repository, "commit", "-m", "initial");
    git(repository, "worktree", "add", "-b", "feature-test", worktree);

    assert.equal(validateManagedWorktree(repository, worktree), fs.realpathSync(worktree));
    assert.throws(() => validateManagedWorktree(repository, repository), /did not enter/i);

    const stateFile = path.join(fixture, "state.json");
    fs.writeFileSync(stateFile, JSON.stringify({
      version: 1,
      pairs: {
        feature: {
          feature: "feature",
          displayName: "Feature",
          repositoryRoot: repository,
          projectRoot: worktree,
          worktreeName: "feature-test",
          worktreePending: false,
          mode: "manual",
          status: "idle",
          autoRound: 0,
          autoRoundLimit: null,
          pmSeeded: false,
          updatedAt: new Date(0).toISOString()
        }
      }
    }), "utf8");
    assert.equal(resolveActiveProjectRoot(repository, worktree, stateFile), fs.realpathSync(worktree));
    assert.throws(() => resolveActiveProjectRoot(repository, fixture, stateFile), /not an active authenticated worktree/i);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
