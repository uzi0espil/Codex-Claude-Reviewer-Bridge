import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

function canonical(value: string): string {
  const resolved = fs.realpathSync(path.resolve(value)).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function gitPath(root: string, argument: string): string {
  const result = spawnSync("git", ["-C", root, "rev-parse", argument], {
    encoding: "utf8",
    windowsHide: true
  });
  if (result.status !== 0) {
    throw new Error(`Cannot inspect Git worktree '${root}': ${(result.stderr || result.stdout || "git rev-parse failed").trim()}`);
  }
  const value = String(result.stdout).trim();
  return path.isAbsolute(value) ? value : path.resolve(root, value);
}

export function validateManagedWorktree(repositoryRoot: string, candidate: string): string {
  const repository = canonical(repositoryRoot);
  const worktree = canonical(candidate);
  const topLevel = canonical(gitPath(worktree, "--show-toplevel"));
  if (topLevel !== worktree) throw new Error(`Claude reported '${candidate}', which is not a Git worktree root.`);
  if (worktree === repository) throw new Error("Claude did not enter the requested new Git worktree.");

  const repositoryCommon = canonical(gitPath(repository, "--git-common-dir"));
  const worktreeCommon = canonical(gitPath(worktree, "--git-common-dir"));
  if (repositoryCommon !== worktreeCommon) {
    throw new Error(`Claude's worktree '${candidate}' does not belong to '${repositoryRoot}'.`);
  }
  return fs.realpathSync(path.resolve(candidate));
}

export function samePath(left: string, right: string): boolean {
  try {
    return canonical(left) === canonical(right);
  } catch {
    return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
  }
}
