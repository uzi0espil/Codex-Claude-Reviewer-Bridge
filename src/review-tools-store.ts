import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
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

export type ReviewToolsProposalSummary = {
  proposalSha256?: string;
  valid: boolean;
  writable: boolean;
  errors: string[];
  warnings: string[];
  coverage: ReviewToolsPreflightResult["coverage"];
  runnerPolicy?: ReviewToolsManifestProposal["runnerPolicy"];
  readinessDefaults?: ReviewToolsManifestProposal["readinessDefaults"];
  requirements: Array<{
    id: string;
    title: string;
    requiredWhen: string;
    disposition: "tool" | "gap" | "missing";
    toolIds?: string[];
    gapReason?: string;
    accepted?: boolean;
  }>;
  tools: Array<{
    id: string;
    title: string;
    runner: ReviewToolsManifestProposal["tools"][number]["runner"]["kind"];
    readiness: string;
    worktree: string;
    command: string;
    inputs: Array<{ name: string; type: string; required: boolean }>;
  }>;
};

export type ReviewToolsReadinessCache = {
  schemaVersion: 1;
  manifestSha256: string;
  updatedAt: string;
  tools: Record<string, ReviewToolProbeRecord>;
};

export class ReviewToolsProposalRegistry {
  readonly #limit: number;
  readonly #proposals = new Map<string, ReviewToolsManifestProposal>();

  constructor(limit = 8) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Proposal registry limit must be between 1 and 100.");
    this.#limit = limit;
  }

  add(proposal: ReviewToolsManifestProposal): string {
    const sha256 = reviewToolsProposalSha256(proposal);
    this.#proposals.delete(sha256);
    this.#proposals.set(sha256, proposal);
    while (this.#proposals.size > this.#limit) this.#proposals.delete(this.#proposals.keys().next().value!);
    return sha256;
  }

  get(sha256: string): ReviewToolsManifestProposal {
    const normalized = sha256.toLowerCase();
    const proposal = this.#proposals.get(normalized);
    if (!proposal) throw new Error("The proposal handle is unavailable or expired. Validate the proposal again before inspecting or approving it.");
    if (reviewToolsProposalSha256(proposal) !== normalized) throw new Error("The cached review-tool proposal no longer matches its approval handle.");
    return proposal;
  }
}

function hash(value: Buffer | string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function reviewToolsProposalSha256(manifest: ReviewToolsManifestProposal): string {
  return hash(JSON.stringify(manifest));
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
  const assertRunnerPaths = (runner: { kind: string; cwd: string; files?: string[] }, label: string): void => {
    if (runner.cwd !== ".") validatedRepositoryPath(projectRoot, runner.cwd, `working directory for '${label}'`);
    if (runner.kind !== "host") {
      for (const file of runner.files ?? []) validatedRepositoryPath(projectRoot, file, `Compose file for '${label}'`);
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
    if (recipe.runner.kind === "compose_exec" && recipe.runner.worktree.mode === "bind") {
      for (const claim of recipe.runner.worktree.paths) {
        validatedRepositoryPath(projectRoot, claim.repositoryPath, `worktree path for '${recipe.id}'`);
      }
    }
    if (recipe.readiness?.mode === "probe") {
      assertRunnerPaths(recipe.readiness.runner, `${recipe.id} readiness probe`);
    }
  }
}

type ComposeBind = { source: string; target: string; composeFile: string };

function isPathLikeComposeSource(source: string): boolean {
  return source === "." || source === ".." || source.startsWith("./") || source.startsWith("../")
    || source.startsWith("/") || source.startsWith("~") || /^[A-Za-z]:[\\/]/.test(source);
}

function resolveComposeSource(projectDirectory: string, source: string): string {
  if (source === "~") return os.homedir();
  if (source.startsWith("~/") || source.startsWith("~\\")) return path.resolve(os.homedir(), source.slice(2));
  return path.resolve(projectDirectory, source);
}

function shortComposeBind(value: string, composeFile: string, projectDirectory: string): ComposeBind | undefined {
  const parts = value.split(":");
  let source: string | undefined;
  let target: string | undefined;
  if (parts.length >= 3 && /^[A-Za-z]$/.test(parts[0]) && /^[\\/]/.test(parts[1])) {
    source = `${parts[0]}:${parts[1]}`;
    target = parts[2];
  } else if (parts.length >= 2) {
    [source, target] = parts;
  }
  if (!source || !target || !isPathLikeComposeSource(source) || !path.posix.isAbsolute(target.replaceAll("\\", "/"))) return undefined;
  return {
    source: resolveComposeSource(projectDirectory, source),
    target: path.posix.normalize(target.replaceAll("\\", "/")),
    composeFile
  };
}

function composeServiceBinds(files: string[], service: string, projectRoot: string): { binds: ComposeBind[]; errors: string[] } {
  const byTarget = new Map<string, ComposeBind>();
  const errors: string[] = [];
  const firstComposeFile = path.resolve(projectRoot, ...files[0].replaceAll("\\", "/").split("/"));
  const projectDirectory = path.dirname(firstComposeFile);
  for (const relativeFile of files) {
    const absoluteFile = path.resolve(projectRoot, ...relativeFile.replaceAll("\\", "/").split("/"));
    let document: unknown;
    try {
      document = parseYaml(fs.readFileSync(absoluteFile, "utf8"));
    } catch (error) {
      errors.push(`Cannot parse Compose file '${relativeFile}' while checking worktree mounts: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const serviceValue = document && typeof document === "object"
      ? (document as { services?: Record<string, unknown> }).services?.[service]
      : undefined;
    if (!serviceValue || typeof serviceValue !== "object") continue;
    const volumes = (serviceValue as { volumes?: unknown }).volumes;
    if (!Array.isArray(volumes)) continue;
    for (const volume of volumes) {
      let bind: ComposeBind | undefined;
      if (typeof volume === "string") {
        bind = shortComposeBind(volume, absoluteFile, projectDirectory);
      } else if (volume && typeof volume === "object") {
        const entry = volume as { type?: unknown; source?: unknown; target?: unknown };
        if ((entry.type === undefined || entry.type === "bind") && typeof entry.source === "string"
            && typeof entry.target === "string" && isPathLikeComposeSource(entry.source)
            && path.posix.isAbsolute(entry.target.replaceAll("\\", "/"))) {
          bind = {
            source: resolveComposeSource(projectDirectory, entry.source),
            target: path.posix.normalize(entry.target.replaceAll("\\", "/")),
            composeFile: absoluteFile
          };
        }
      }
      if (bind) byTarget.set(bind.target, bind);
    }
  }
  return { binds: [...byTarget.values()], errors };
}

function fixedRepositoryReferences(recipe: ReviewToolsManifestProposal["tools"][number], projectRoot: string): string[] {
  if (recipe.runner.kind !== "compose_exec") return [];
  const references = new Set<string>();
  const commandCandidates = /[\\/]/.test(recipe.runner.command) || recipe.runner.command.startsWith(".")
    ? [recipe.runner.command]
    : [];
  for (const token of [...commandCandidates, ...recipe.runner.args]) {
    if (!token || token.includes("{input:") || token.includes("{stage}") || token.startsWith("-")) continue;
    try {
      const safe = validatedRepositoryPath(projectRoot, token, `fixed argument for '${recipe.id}'`).split("::", 1)[0];
      if (fs.existsSync(path.resolve(projectRoot, ...safe.split("/")))) references.add(safe);
    } catch {
      // Most argv entries are not repository paths. Only existing safe paths are provenance evidence.
    }
  }
  return [...references];
}

function isPathWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function validateComposeWorktree(
  recipe: ReviewToolsManifestProposal["tools"][number],
  projectRoot: string
): string[] {
  if (recipe.runner.kind !== "compose_exec") return [];
  const fixedReferences = fixedRepositoryReferences(recipe, projectRoot);
  if (recipe.runner.worktree.mode === "unspecified") {
    return [`Tool '${recipe.id}' must explicitly declare whether it uses authoritative worktree binds or is runtime-only.`];
  }
  if (recipe.runner.worktree.mode === "none") {
    const errors: string[] = [];
    if (recipe.inputs.some(({ type }) => type === "repo_paths")) {
      errors.push(`Tool '${recipe.id}' accepts repository paths but declares runtime-only Compose execution.`);
    }
    if (fixedReferences.length) {
      errors.push(`Tool '${recipe.id}' references repository content (${fixedReferences.join(", ")}) but declares runtime-only Compose execution.`);
    }
    return errors;
  }
  const { binds, errors } = composeServiceBinds(recipe.runner.files, recipe.runner.service, projectRoot);
  for (const claim of recipe.runner.worktree.paths) {
    let safeRepositoryPath: string;
    try {
      safeRepositoryPath = validatedRepositoryPath(projectRoot, claim.repositoryPath, `worktree path for '${recipe.id}'`);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      continue;
    }
    const repositoryPath = path.resolve(projectRoot, ...safeRepositoryPath.split("/"));
    if (!fs.existsSync(repositoryPath)) {
      errors.push(`Tool '${recipe.id}' declares a worktree path that does not exist: ${safeRepositoryPath}`);
      continue;
    }
    const containerPath = path.posix.normalize(claim.containerPath.replaceAll("\\", "/"));
    const matching = binds
      .filter((bind) => containerPath === bind.target || containerPath.startsWith(`${bind.target.replace(/\/$/, "")}/`))
      .sort((left, right) => right.target.length - left.target.length)[0];
    if (!matching) {
      errors.push(`Tool '${recipe.id}' expects current worktree path '${safeRepositoryPath}' at '${containerPath}', but service '${recipe.runner.service}' has no matching bind mount.`);
      continue;
    }
    const suffix = path.posix.relative(matching.target, containerPath);
    const mountedHostPath = path.resolve(matching.source, ...suffix.split("/").filter(Boolean));
    if (canonical(mountedHostPath) !== canonical(repositoryPath)) {
      const sourceDisplay = isPathWithin(projectRoot, matching.source)
        ? path.relative(projectRoot, matching.source).replaceAll("\\", "/") || "."
        : matching.source;
      errors.push(`Tool '${recipe.id}' maps '${containerPath}' from '${sourceDisplay}', not authoritative repository path '${safeRepositoryPath}'.`);
    }
  }
  for (const reference of fixedReferences) {
    const referencePath = path.resolve(projectRoot, ...reference.split("/"));
    const covered = recipe.runner.worktree.paths.some((claim) => {
      try {
        const safeClaim = validatedRepositoryPath(projectRoot, claim.repositoryPath, `worktree path for '${recipe.id}'`);
        return isPathWithin(path.resolve(projectRoot, ...safeClaim.split("/")), referencePath);
      } catch {
        return false;
      }
    });
    if (!covered) errors.push(`Tool '${recipe.id}' references repository content '${reference}' outside its declared worktree paths.`);
  }
  return errors;
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
    errors.push(...validateComposeWorktree(recipe, projectRoot));
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

function compactCommand(command: string[]): string {
  const rendered = command.map((part) => /\s/.test(part) ? JSON.stringify(part) : part).join(" ");
  return rendered.length <= 240 ? rendered : `${rendered.slice(0, 237)}...`;
}

export function summarizeReviewToolsPreflight(preflight: ReviewToolsPreflightResult): ReviewToolsProposalSummary {
  const manifest = preflight.manifest;
  if (!manifest) {
    return {
      valid: preflight.valid,
      writable: preflight.writable,
      errors: preflight.errors,
      warnings: preflight.warnings,
      coverage: preflight.coverage,
      requirements: [],
      tools: []
    };
  }
  const coverageById = new Map(manifest.coverage.map((entry) => [entry.requirementId, entry]));
  const previewsById = new Map(preflight.commandPreviews.map((preview) => [preview.id, preview]));
  const readinessById = new Map(preflight.doctor?.tools.map((tool) => [tool.id, tool]) ?? []);
  return {
    proposalSha256: reviewToolsProposalSha256(manifest),
    valid: preflight.valid,
    writable: preflight.writable,
    errors: preflight.errors,
    warnings: preflight.warnings,
    coverage: preflight.coverage,
    runnerPolicy: manifest.runnerPolicy,
    readinessDefaults: manifest.readinessDefaults,
    requirements: manifest.requirements.map((requirement) => {
      const coverage = coverageById.get(requirement.id);
      return {
        id: requirement.id,
        title: requirement.title,
        requiredWhen: requirement.requiredWhen,
        disposition: coverage?.disposition ?? "missing",
        ...(coverage?.disposition === "tool" ? { toolIds: coverage.toolIds } : {}),
        ...(coverage?.disposition === "gap" ? { gapReason: coverage.reason, accepted: coverage.accepted } : {})
      };
    }),
    tools: manifest.tools.map((tool) => {
      const readiness = tool.readiness ?? manifest.readinessDefaults;
      const effective = readinessById.get(tool.id);
      return {
        id: tool.id,
        title: tool.title,
        runner: tool.runner.kind,
        readiness: `${readiness.mode}:${effective?.status ?? "unknown"}`,
        worktree: tool.runner.kind === "compose_exec"
          ? tool.runner.worktree.mode === "bind"
            ? `bind:${tool.runner.worktree.paths.map(({ repositoryPath }) => repositoryPath).join(",")}`
            : tool.runner.worktree.mode
          : tool.runner.kind === "compose_stage_exec" ? `staged:${tool.runner.sourceDirectory}` : "host",
        command: compactCommand(previewsById.get(tool.id)?.command ?? []),
        inputs: tool.inputs.map(({ name, type, required }) => ({ name, type, required }))
      };
    })
  };
}

export function reviewToolsProposalDetails(
  manifest: ReviewToolsManifestProposal,
  toolIds?: string[],
  requirementIds?: string[]
): {
  proposalSha256: string;
  requirements: ReviewToolsManifestProposal["requirements"];
  coverage: ReviewToolsManifestProposal["coverage"];
  tools: Array<ReviewToolsManifestProposal["tools"][number] & { commandPreview: string[] }>;
} {
  if (!toolIds?.length && !requirementIds?.length) {
    throw new Error("Select at least one proposal tool or validation requirement for detailed inspection.");
  }
  const selectedTools = new Set(toolIds ?? []);
  const selectedRequirements = new Set(requirementIds ?? []);
  const unknownTools = toolIds?.filter((id) => !manifest.tools.some((tool) => tool.id === id)) ?? [];
  const unknownRequirements = requirementIds?.filter((id) => !manifest.requirements.some((requirement) => requirement.id === id)) ?? [];
  if (unknownTools.length || unknownRequirements.length) {
    throw new Error([
      unknownTools.length ? `Unknown proposal tool ids: ${unknownTools.join(", ")}.` : "",
      unknownRequirements.length ? `Unknown proposal requirement ids: ${unknownRequirements.join(", ")}.` : ""
    ].filter(Boolean).join(" "));
  }
  for (const entry of manifest.coverage) {
    if (entry.disposition === "tool" && entry.toolIds.some((toolId) => selectedTools.has(toolId))) {
      selectedRequirements.add(entry.requirementId);
    }
  }
  for (const entry of manifest.coverage) {
    if (selectedRequirements.has(entry.requirementId) && entry.disposition === "tool") {
      for (const toolId of entry.toolIds) selectedTools.add(toolId);
    }
  }
  return {
    proposalSha256: reviewToolsProposalSha256(manifest),
    requirements: manifest.requirements.filter(({ id }) => selectedRequirements.has(id)),
    coverage: manifest.coverage.filter(({ requirementId }) => selectedRequirements.has(requirementId)),
    tools: manifest.tools
      .filter(({ id }) => selectedTools.has(id))
      .map((tool) => ({ ...tool, commandPreview: commandPreview(tool) }))
  };
}

export function acceptReviewToolsProposalGaps(manifest: ReviewToolsManifestProposal): ReviewToolsManifestProposal {
  return reviewToolsManifestProposalSchema.parse({
    ...manifest,
    coverage: manifest.coverage.map((entry) => entry.disposition === "gap" ? { ...entry, accepted: true } : entry)
  });
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
