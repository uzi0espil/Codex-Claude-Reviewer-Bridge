import path from "node:path";
import fs from "node:fs";
import { validateManagedWorktree } from "./worktree.js";

type Request = (method: string, params: Record<string, unknown>) => Promise<any>;
type Projects = Record<string, { trust_level?: string }>;

function trustPath(value: string): string {
  let normalized = path.resolve(value);
  try { normalized = fs.realpathSync(normalized); } catch { /* Saved paths may no longer exist. */ }
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function trustLevels(projects: Projects | undefined, root: string): (string | undefined)[] {
  return Object.entries(projects ?? {})
    .filter(([key]) => trustPath(key) === trustPath(root))
    .map(([, project]) => project.trust_level);
}

/** Remote Codex TUIs require an explicit cwd entry even for a trusted Git repository. */
export async function inheritWorktreeTrust(
  repositoryRoot: string, candidate: string, configFile: string, request: Request
): Promise<boolean> {
  const worktree = validateManagedWorktree(repositoryRoot, candidate);
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await request("config/read", { cwd: worktree, includeLayers: true });
    const user = response.layers?.find((layer: any) =>
      layer.name?.type === "user" && !layer.name.profile
      && trustPath(layer.name.file) === trustPath(configFile));
    // Only carry an explicit decision from this reviewer's own user config.
    const rootLevels = trustLevels(user?.config?.projects, repositoryRoot);
    const effectiveRoot = trustLevels(response.config?.projects, repositoryRoot);
    const worktreeLevels = trustLevels(response.config?.projects, worktree);
    if (!rootLevels.includes("trusted") || rootLevels.includes("untrusted")
      || effectiveRoot.includes("untrusted") || worktreeLevels.includes("untrusted")
      || worktreeLevels.includes("trusted")) return false;
    if (typeof user?.version !== "string") throw new Error("Codex did not return a version for the reviewer config.");
    const key = process.platform === "win32" ? worktree.toLowerCase() : worktree;
    try {
      await request("config/value/write", {
        keyPath: `projects.${JSON.stringify(key)}.trust_level`,
        value: "trusted", mergeStrategy: "replace",
        filePath: path.resolve(configFile), expectedVersion: user.version
      });
      return true;
    } catch (error) {
      // A concurrent launch or user edit may have changed trust. Re-read before retrying.
      if (attempt === 2) throw error;
    }
  }
  return false;
}
