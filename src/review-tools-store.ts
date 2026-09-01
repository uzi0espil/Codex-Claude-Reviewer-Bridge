import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { discoverReviewTools, type ReviewToolDiscovery } from "./review-tools-discovery.js";
import {
  loadBoundProjectRoot,
  reviewToolsManifestSchema,
  validatedRepositoryPath,
  type ReviewToolProbeRecord,
  type ReviewToolsManifest
} from "./review-tools.js";
import { reviewerRoot, runtimeDirectory } from "./paths.js";

export const reviewToolsManifestPath = path.join(reviewerRoot, "review-tools.local.json");
export const reviewToolsDetectionPath = path.join(reviewerRoot, "review-tools.detected.json");
export const reviewToolsReadinessPath = path.join(runtimeDirectory, "review-tools", "readiness.json");
export const maxReviewToolsManifestBytes = 1_048_576;

export type HashedFile<T> = {
  path: string;
  sha256: string;
  bytes: number;
  value: T;
};

export type ManifestWriteResult = {
  path: string;
  sha256: string;
  bytes: number;
  created: boolean;
  toolCount: number;
  restartRequired: true;
};

export type ReviewToolsReadinessCache = {
  schemaVersion: 1;
  manifestSha256: string;
  updatedAt: string;
  tools: Record<string, ReviewToolProbeRecord>;
};

function hash(value: Buffer | string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonical(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function readJsonFile<T>(filename: string): HashedFile<T> | undefined {
  if (!fs.existsSync(filename)) return undefined;
  const encoded = fs.readFileSync(filename);
  return {
    path: filename,
    sha256: hash(encoded),
    bytes: encoded.byteLength,
    value: JSON.parse(encoded.toString("utf8")) as T
  };
}

export function readReviewToolsManifestRevision(
  filename = reviewToolsManifestPath
): { path: string; sha256: string; bytes: number } | undefined {
  if (!fs.existsSync(filename)) return undefined;
  const encoded = fs.readFileSync(filename);
  return { path: filename, sha256: hash(encoded), bytes: encoded.byteLength };
}

function atomicWrite(filename: string, encoded: Buffer): void {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, encoded, { flag: "wx" });
    fs.renameSync(temporary, filename);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
}

function assertManifestPaths(manifest: ReviewToolsManifest, projectRoot: string): void {
  const assertRunnerPaths = (runner: ReviewToolsManifest["tools"][number]["runner"], label: string): void => {
    if (runner.cwd !== ".") validatedRepositoryPath(projectRoot, runner.cwd, `working directory for '${label}'`);
    if (runner.kind !== "host") {
      for (const file of runner.files) validatedRepositoryPath(projectRoot, file, `Compose file for '${label}'`);
    }
  };
  for (const recipe of manifest.tools) {
    assertRunnerPaths(recipe.runner, recipe.id);
    if (recipe.runner.kind === "compose_stage_exec") {
      validatedRepositoryPath(projectRoot, recipe.runner.sourceDirectory, `staged source directory for '${recipe.id}'`);
      for (const artifact of recipe.runner.artifacts) {
        if (artifact.includes("{stage}")) throw new Error(`Artifact path for '${recipe.id}' must be repository-relative, not stage-absolute.`);
        validatedRepositoryPath(projectRoot, artifact.replaceAll(/\{[a-z][a-z0-9_]*\}/g, "placeholder"), `artifact path for '${recipe.id}'`);
      }
    }
    if (recipe.readiness?.mode === "probe") {
      assertRunnerPaths(recipe.readiness.runner, `${recipe.id} readiness probe`);
    }
  }
}

function isProbeRecord(value: unknown): value is ReviewToolProbeRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.success === "boolean"
    && typeof record.probedAt === "string"
    && typeof record.expiresAt === "string"
    && (typeof record.exitCode === "number" || record.exitCode === null)
    && typeof record.timedOut === "boolean"
    && typeof record.durationMs === "number"
    && (record.error === undefined || typeof record.error === "string");
}

export function readReviewToolsReadinessCache(
  manifestSha256: string,
  filename = reviewToolsReadinessPath
): ReviewToolsReadinessCache | undefined {
  try {
    const current = readJsonFile<unknown>(filename)?.value;
    if (!current || typeof current !== "object") return undefined;
    const cache = current as Partial<ReviewToolsReadinessCache>;
    if (cache.schemaVersion !== 1 || cache.manifestSha256 !== manifestSha256 || !cache.tools || typeof cache.tools !== "object") {
      return undefined;
    }
    if (!Object.values(cache.tools).every(isProbeRecord)) return undefined;
    return cache as ReviewToolsReadinessCache;
  } catch {
    return undefined;
  }
}

export function writeReviewToolsReadinessCache(
  manifestSha256: string,
  results: Record<string, ReviewToolProbeRecord>,
  filename = reviewToolsReadinessPath
): ReviewToolsReadinessCache {
  const existing = readReviewToolsReadinessCache(manifestSha256, filename);
  const cache: ReviewToolsReadinessCache = {
    schemaVersion: 1,
    manifestSha256,
    updatedAt: new Date().toISOString(),
    tools: { ...(existing?.tools ?? {}), ...results }
  };
  atomicWrite(filename, Buffer.from(`${JSON.stringify(cache, null, 2)}\n`, "utf8"));
  return cache;
}

export function readReviewToolsManifestFile(
  filename = reviewToolsManifestPath,
  projectRoot = loadBoundProjectRoot()
): HashedFile<ReviewToolsManifest> | undefined {
  const current = readJsonFile<unknown>(filename);
  if (!current) return undefined;
  const manifest = reviewToolsManifestSchema.parse(current.value);
  if (canonical(manifest.projectRoot) !== canonical(projectRoot)) {
    throw new Error(`Review tool manifest is bound to '${manifest.projectRoot}', not '${projectRoot}'.`);
  }
  assertManifestPaths(manifest, projectRoot);
  return { ...current, value: manifest };
}

export function writeReviewToolsManifest(
  proposedManifest: unknown,
  expectedSha256: string | null,
  filename = reviewToolsManifestPath,
  projectRoot = loadBoundProjectRoot()
): ManifestWriteResult {
  const manifest = reviewToolsManifestSchema.parse(proposedManifest);
  if (canonical(manifest.projectRoot) !== canonical(projectRoot)) {
    throw new Error(`Review tool manifest must be bound to '${projectRoot}', not '${manifest.projectRoot}'.`);
  }
  assertManifestPaths(manifest, projectRoot);
  const existing = readReviewToolsManifestRevision(filename);
  const actualHash = existing?.sha256 ?? null;
  const normalizedExpectedHash = expectedSha256?.toLowerCase() ?? null;
  if (actualHash !== normalizedExpectedHash) {
    throw new Error(
      `Review tool manifest changed since it was inspected (expected ${expectedSha256 ?? "no file"}, found ${actualHash ?? "no file"}). Re-read it and review the updated manifest before saving.`
    );
  }

  const encoded = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  if (encoded.byteLength > maxReviewToolsManifestBytes) {
    throw new Error(`Review tool manifest exceeds the ${maxReviewToolsManifestBytes}-byte limit.`);
  }
  atomicWrite(filename, encoded);
  return {
    path: filename,
    sha256: hash(encoded),
    bytes: encoded.byteLength,
    created: !existing,
    toolCount: manifest.tools.length,
    restartRequired: true
  };
}

export function readReviewToolsDetection(
  filename = reviewToolsDetectionPath,
  projectRoot = loadBoundProjectRoot()
): HashedFile<ReviewToolDiscovery> | undefined {
  const detection = readJsonFile<ReviewToolDiscovery>(filename);
  if (!detection) return undefined;
  if (detection.value.schemaVersion !== 1 || !Array.isArray(detection.value.candidates)) {
    throw new Error("Review tool detection file has an unsupported format. Refresh discovery before using it.");
  }
  if (canonical(detection.value.projectRoot) !== canonical(projectRoot)) {
    throw new Error(`Review tool detection is bound to '${detection.value.projectRoot}', not '${projectRoot}'.`);
  }
  return detection;
}

export function refreshReviewToolsDetection(
  projectRoot = loadBoundProjectRoot(),
  filename = reviewToolsDetectionPath
): HashedFile<ReviewToolDiscovery> {
  const detection = discoverReviewTools(projectRoot);
  const encoded = Buffer.from(`${JSON.stringify(detection, null, 2)}\n`, "utf8");
  atomicWrite(filename, encoded);
  return {
    path: filename,
    sha256: hash(encoded),
    bytes: encoded.byteLength,
    value: detection
  };
}
