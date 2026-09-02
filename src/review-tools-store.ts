import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { discoverReviewTools, type ReviewToolDiscovery } from "./review-tools-discovery.js";
import {
  currentReviewToolsManifestSchema,
  doctorReviewTools,
  loadBoundProjectRoot,
  reviewToolsManifestSchema,
  reviewToolsManifestProposalSchema,
  validatedRepositoryPath,
  type CurrentReviewToolsManifest,
  type ReviewToolProbeRecord,
  type ReviewToolsManifest,
  type ReviewToolsManifestProposal
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
  requirementCount: number;
  acceptedGapCount: number;
  approvedAt: string;
  restartRequired: true;
};

export type ReviewToolsPreflightResult = {
  valid: boolean;
  writable: boolean;
  errors: string[];
  warnings: string[];
  coverage: {
    requirementCount: number;
    coveredByTools: number;
    acceptedGaps: number;
    pendingGaps: number;
    detectedRequirementCount: number;
  };
  doctor?: ReturnType<typeof doctorReviewTools>;
  commandPreviews: Array<{
    id: string;
    runner: ReviewToolsManifestProposal["tools"][number]["runner"]["kind"];
    command: string[];
    inputs: Array<{ name: string; type: string; required: boolean }>;
  }>;
  manifest?: ReviewToolsManifestProposal;
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
    for (const input of recipe.inputs) {
      if (input.type === "repo_paths") {
        for (const prefix of input.allowedPrefixes) {
          validatedRepositoryPath(projectRoot, prefix, `approved path prefix for '${recipe.id}.${input.name}'`);
        }
      }
    }
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

function commandPreview(recipe: ReviewToolsManifestProposal["tools"][number]): string[] {
  switch (recipe.runner.kind) {
    case "host":
      return [recipe.runner.command, ...recipe.runner.args];
    case "compose":
      return ["docker", "compose", ...recipe.runner.files.flatMap((file) => ["-f", file]), ...recipe.runner.args];
    case "compose_exec":
      return [
        "docker", "compose", ...recipe.runner.files.flatMap((file) => ["-f", file]), "exec", "-T",
        ...(recipe.runner.workdir ? ["-w", recipe.runner.workdir] : []), recipe.runner.service,
        recipe.runner.command, ...recipe.runner.args
      ];
    case "compose_stage_exec":
      return [
        "docker", "compose", ...recipe.runner.files.flatMap((file) => ["-f", file]), "exec", "-T",
        "-w", recipe.runner.workdir, recipe.runner.service, recipe.runner.command, ...recipe.runner.args
      ];
  }
}

function runnerPolicyKey(kind: ReviewToolsManifestProposal["tools"][number]["runner"]["kind"]): keyof ReviewToolsManifestProposal["runnerPolicy"] {
  switch (kind) {
    case "host": return "host";
    case "compose": return "compose";
    case "compose_exec": return "composeExec";
    case "compose_stage_exec": return "composeStageExec";
  }
}

export function preflightReviewToolsManifest(
  proposedManifest: unknown,
  projectRoot = loadBoundProjectRoot(),
  detectionFilename = reviewToolsDetectionPath,
  isExecutableAvailable?: (command: string, cwd: string) => boolean
): ReviewToolsPreflightResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const parsed = reviewToolsManifestProposalSchema.safeParse(proposedManifest);
  if (!parsed.success) {
    return {
      valid: false,
      writable: false,
      errors: parsed.error.issues.map((issue) => `${issue.path.join(".") || "manifest"}: ${issue.message}`),
      warnings,
      coverage: { requirementCount: 0, coveredByTools: 0, acceptedGaps: 0, pendingGaps: 0, detectedRequirementCount: 0 },
      commandPreviews: []
    };
  }
  const manifest = parsed.data;
  if (canonical(manifest.projectRoot) !== canonical(projectRoot)) {
    errors.push(`Review tool manifest must be bound to '${projectRoot}', not '${manifest.projectRoot}'.`);
  }
  try {
    assertManifestPaths({ ...manifest, approvedAt: new Date(0).toISOString() }, projectRoot);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  let detection: HashedFile<ReviewToolDiscovery> | undefined;
  try {
    detection = readReviewToolsDetection(detectionFilename, projectRoot);
    if (!detection) errors.push("Review tool detection is missing. Refresh detection before validating a manifest proposal.");
    else if (detection.sha256 !== manifest.detectionSha256.toLowerCase()) {
      errors.push(`Detection changed since the proposal was built (expected ${manifest.detectionSha256.toLowerCase()}, found ${detection.sha256}). Refresh the inventory before approval.`);
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  const toolIds = new Set(manifest.tools.map(({ id }) => id));
  const toolsById = new Map(manifest.tools.map((tool) => [tool.id, tool]));
  const requirementIds = new Set(manifest.requirements.map(({ id }) => id));
  const requirementsById = new Map(manifest.requirements.map((requirement) => [requirement.id, requirement]));
  const coverageByRequirement = new Map(manifest.coverage.map((entry) => [entry.requirementId, entry]));
  for (const requirement of manifest.requirements) {
    if (!coverageByRequirement.has(requirement.id)) errors.push(`Validation requirement '${requirement.id}' has no coverage disposition.`);
  }
  for (const entry of manifest.coverage) {
    if (!requirementIds.has(entry.requirementId)) errors.push(`Coverage references unknown validation requirement '${entry.requirementId}'.`);
    if (entry.disposition === "tool") {
      for (const toolId of entry.toolIds) {
        if (!toolIds.has(toolId)) errors.push(`Coverage for '${entry.requirementId}' references unknown tool '${toolId}'.`);
        const tool = toolsById.get(toolId);
        const requirement = requirementsById.get(entry.requirementId);
        if (tool && requirement && !requirement.allowedRunners.includes(tool.runner.kind)) {
          errors.push(`Tool '${toolId}' uses ${tool.runner.kind}, which is not an allowed runner for validation requirement '${entry.requirementId}'.`);
        }
      }
    } else {
      const requirement = requirementsById.get(entry.requirementId);
      const permitted = requirement?.allowedRunners.filter((kind) => manifest.runnerPolicy[runnerPolicyKey(kind)] === "allowed") ?? [];
      if (permitted.length) {
        warnings.push(`Validation requirement '${entry.requirementId}' is a gap even though its permitted runner kinds are authorized (${permitted.join(", ")}); verify that prerequisites, cost, or side effects genuinely prevent a bounded tool.`);
      }
    }
  }

  const allDetectedIds = new Set(detection?.value.requirements.map(({ id }) => id) ?? []);
  const detectedIds = new Set(detection?.value.requirements.filter(({ role }) => role === "validation").map(({ id }) => id) ?? []);
  const inventoriedDetectedIds = new Set(manifest.requirements.flatMap(({ detectedRequirementIds }) => detectedRequirementIds));
  for (const detectedId of detectedIds) {
    if (!inventoriedDetectedIds.has(detectedId)) errors.push(`Detected CI validation requirement '${detectedId}' is absent from the curated inventory.`);
  }
  for (const detectedId of inventoriedDetectedIds) {
    if (!allDetectedIds.has(detectedId)) errors.push(`Inventory references unknown or stale detected CI requirement '${detectedId}'.`);
  }

  for (const recipe of manifest.tools) {
    const policy = runnerPolicyKey(recipe.runner.kind);
    if (manifest.runnerPolicy[policy] !== "allowed") {
      errors.push(`Tool '${recipe.id}' uses ${recipe.runner.kind}, but runner policy '${policy}' is disallowed.`);
    }
    if (recipe.readiness?.mode === "probe") {
      const probePolicy = runnerPolicyKey(recipe.readiness.runner.kind);
      if (manifest.runnerPolicy[probePolicy] !== "allowed") {
        errors.push(`Readiness probe for '${recipe.id}' uses ${recipe.readiness.runner.kind}, but runner policy '${probePolicy}' is disallowed.`);
      }
    }
    for (const input of recipe.inputs) {
      if ((input.type === "repo_paths" || input.type === "strings") && input.flag && input.maxItems > 1) {
        warnings.push(`Tool '${recipe.id}' input '${input.name}' emits one '${input.flag}' followed by up to ${input.maxItems} values; verify that the target CLI accepts that cardinality.`);
      }
      if (input.type === "repo_paths" && !input.allowedPrefixes.length) {
        warnings.push(`Tool '${recipe.id}' input '${input.name}' accepts paths anywhere in the repository; consider approved prefixes.`);
      }
    }
  }

  const effectiveManifest: CurrentReviewToolsManifest = currentReviewToolsManifestSchema.parse({
    ...manifest,
    approvedAt: new Date(0).toISOString()
  });
  const doctor = doctorReviewTools(effectiveManifest, projectRoot, isExecutableAvailable);
  for (const tool of doctor.tools) {
    if (tool.status === "missing") errors.push(`Tool '${tool.id}' has structural readiness failures: ${tool.issues.join("; ")}`);
    if (tool.status === "needs_runtime_probe") warnings.push(`Tool '${tool.id}' still requires runtime evidence under its selected readiness mode.`);
  }
  const referencedToolIds = new Set(manifest.coverage.flatMap((entry) => entry.disposition === "tool" ? entry.toolIds : []));
  for (const toolId of toolIds) {
    if (!referencedToolIds.has(toolId)) warnings.push(`Tool '${toolId}' is supplemental and does not cover a declared validation requirement.`);
  }

  const acceptedGaps = manifest.coverage.filter((entry) => entry.disposition === "gap" && entry.accepted).length;
  const pendingGaps = manifest.coverage.filter((entry) => entry.disposition === "gap" && !entry.accepted).length;
  const coveredByTools = manifest.coverage.filter((entry) => entry.disposition === "tool").length;
  return {
    valid: errors.length === 0,
    writable: errors.length === 0 && pendingGaps === 0,
    errors,
    warnings: [...new Set(warnings)],
    coverage: {
      requirementCount: manifest.requirements.length,
      coveredByTools,
      acceptedGaps,
      pendingGaps,
      detectedRequirementCount: detectedIds.size
    },
    doctor,
    commandPreviews: manifest.tools.map((recipe) => ({
      id: recipe.id,
      runner: recipe.runner.kind,
      command: commandPreview(recipe),
      inputs: recipe.inputs.map(({ name, type, required }) => ({ name, type, required }))
    })),
    manifest
  };
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
  projectRoot = loadBoundProjectRoot(),
  detectionFilename = reviewToolsDetectionPath
): ManifestWriteResult {
  const preflight = preflightReviewToolsManifest(proposedManifest, projectRoot, detectionFilename);
  if (!preflight.writable || !preflight.manifest) {
    const details = [...preflight.errors, ...(preflight.coverage.pendingGaps ? [`${preflight.coverage.pendingGaps} validation gap(s) still await explicit approval.`] : [])];
    throw new Error(`Review tool manifest proposal is not writable: ${details.join(" ")}`);
  }
  const manifest = currentReviewToolsManifestSchema.parse({
    ...preflight.manifest,
    approvedAt: new Date().toISOString()
  });
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
    requirementCount: manifest.requirements.length,
    acceptedGapCount: manifest.coverage.filter((entry) => entry.disposition === "gap").length,
    approvedAt: manifest.approvedAt,
    restartRequired: true
  };
}

export function readReviewToolsDetection(
  filename = reviewToolsDetectionPath,
  projectRoot = loadBoundProjectRoot()
): HashedFile<ReviewToolDiscovery> | undefined {
  const detection = readJsonFile<ReviewToolDiscovery>(filename);
  if (!detection) return undefined;
  if (detection.value.schemaVersion !== 2
      || !Array.isArray(detection.value.requirements)
      || !detection.value.requirements.every(({ role }) => role === "validation" || role === "support")
      || !Array.isArray(detection.value.candidates)) {
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
