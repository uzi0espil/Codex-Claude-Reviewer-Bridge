import fs from "node:fs";
import path from "node:path";
import { statePath } from "./paths.js";
import { BridgeState } from "./types.js";
import { samePath, validateManagedWorktree } from "./worktree.js";

export function resolveActiveProjectRoot(
  boundRoot: string,
  requestedRoot?: string,
  filename = statePath
): string {
  if (!requestedRoot || samePath(boundRoot, requestedRoot)) return fs.realpathSync(path.resolve(boundRoot));
  if (!fs.existsSync(filename)) throw new Error("No active bridge state exists for the requested project root.");
  const state = JSON.parse(fs.readFileSync(filename, "utf8")) as BridgeState;
  const pair = Object.values(state.pairs).find((candidate) =>
    !candidate.worktreePending
    && Boolean(candidate.worktreeName)
    && samePath(candidate.repositoryRoot ?? candidate.projectRoot, boundRoot)
    && samePath(candidate.projectRoot, requestedRoot)
  );
  if (!pair) throw new Error(`'${requestedRoot}' is not an active authenticated worktree for '${boundRoot}'.`);
  return validateManagedWorktree(boundRoot, pair.projectRoot);
}
