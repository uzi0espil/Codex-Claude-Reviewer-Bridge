import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import { reviewerRoot, runtimeDirectory } from "./paths.js";

const annotationSchema = z.object({
  readOnlyHint: z.boolean().default(false),
  destructiveHint: z.boolean().default(false),
  idempotentHint: z.boolean().default(true),
  openWorldHint: z.boolean().default(false)
});

const baseInputSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]*$/),
  description: z.string().min(1).max(500),
  required: z.boolean().default(false),
  flag: z.string().min(1).max(100).optional(),
  valueTemplate: z.string().min(1).max(1_000).optional()
});

const recipeInputSchema = z.discriminatedUnion("type", [
  baseInputSchema.extend({
    type: z.literal("string"),
    default: z.string().optional(),
    pattern: z.string().max(500).optional(),
    maxLength: z.number().int().min(1).max(10_000).default(2_000)
  }),
  baseInputSchema.extend({
    type: z.literal("enum"),
    values: z.array(z.string().min(1).max(500)).min(1).max(500),
    default: z.string().optional()
  }),
  baseInputSchema.extend({
    type: z.literal("integer"),
    default: z.number().int().optional(),
    minimum: z.number().int().optional(),
    maximum: z.number().int().optional()
  }),
  baseInputSchema.extend({
    type: z.literal("boolean"),
    default: z.boolean().optional()
  }),
  baseInputSchema.extend({
    type: z.literal("repo_paths"),
    maxItems: z.number().int().min(1).max(500).default(20),
    allowedPrefixes: z.array(z.string().min(1).max(500)).max(50).default([]),
    extensions: z.array(z.string().regex(/^\.[A-Za-z0-9][A-Za-z0-9._-]*$/)).max(50).default([]),
    pathKind: z.enum(["any", "file", "directory"]).default("any")
  }),
  baseInputSchema.extend({
    type: z.literal("strings"),
    maxItems: z.number().int().min(1).max(500).default(100),
    itemMaxLength: z.number().int().min(1).max(10_000).default(2_000)
  })
]);

const commonRunner = {
  args: z.array(z.string().max(2_000)).max(500).default([]),
  cwd: z.string().max(500).default("."),
  environment: z.record(z.string(), z.string().max(2_000)).default({})
};

const runnerSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("host"),
    command: z.string().min(1).max(500),
    ...commonRunner
  }),
  z.object({
    kind: z.literal("compose"),
    files: z.array(z.string().min(1).max(500)).min(1).max(20),
    ...commonRunner
  }),
  z.object({
    kind: z.literal("compose_exec"),
    files: z.array(z.string().min(1).max(500)).min(1).max(20),
    service: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/),
    workdir: z.string().min(1).max(500).optional(),
    command: z.string().min(1).max(500),
    ...commonRunner
  }),
  z.object({
    kind: z.literal("compose_stage_exec"),
    files: z.array(z.string().min(1).max(500)).min(1).max(20),
    service: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/),
    sourceDirectory: z.string().min(1).max(500),
    workdir: z.string().min(1).max(500),
    command: z.string().min(1).max(500),
    artifacts: z.array(z.string().min(1).max(1_000)).max(50).default([]),
    ...commonRunner
  })
]);

const readinessRunnerSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("host"),
    command: z.string().min(1).max(500),
    ...commonRunner
  }),
  z.object({
    kind: z.literal("compose"),
    files: z.array(z.string().min(1).max(500)).min(1).max(20),
    ...commonRunner
  }),
  z.object({
    kind: z.literal("compose_exec"),
    files: z.array(z.string().min(1).max(500)).min(1).max(20),
    service: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/),
    workdir: z.string().min(1).max(500).optional(),
    command: z.string().min(1).max(500),
    ...commonRunner
  })
]);

const readinessSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("static") }),
  z.object({ mode: z.literal("trusted") }),
  z.object({
    mode: z.literal("probe"),
    runner: readinessRunnerSchema,
    timeoutSeconds: z.number().int().min(1).max(86_400).default(30),
    cacheSeconds: z.number().int().min(1).max(86_400).default(300)
  })
]);

const readinessDefaultsSchema = z.object({
  mode: z.enum(["static", "trusted"]).default("static")
});

export const reviewToolRecipeSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(2_000),
  runner: runnerSchema,
  inputs: z.array(recipeInputSchema).max(50).default([]),
  timeoutSeconds: z.number().int().min(1).max(86_400).default(1_800),
  annotations: annotationSchema.default({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }),
  evidence: z.array(z.string().min(1).max(1_000)).max(100).default([]),
  readiness: readinessSchema.optional()
}).superRefine((recipe, context) => {
  const names = new Set<string>();
  for (const input of recipe.inputs) {
    if (names.has(input.name)) context.addIssue({ code: "custom", message: `Duplicate input '${input.name}'.` });
    names.add(input.name);
    if (input.type === "boolean" && !input.flag) {
      context.addIssue({ code: "custom", message: `Boolean input '${input.name}' requires a flag.` });
    }
    if (input.type === "enum" && input.default !== undefined && !input.values.includes(input.default)) {
      context.addIssue({ code: "custom", message: `Default for '${input.name}' is not one of its values.` });
    }
    if (input.type === "repo_paths") {
      for (const prefix of input.allowedPrefixes) {
        if (!prefix.trim() || prefix.startsWith("-") || path.posix.isAbsolute(prefix.replaceAll("\\", "/"))) {
          context.addIssue({ code: "custom", message: `Repository path prefix for '${input.name}' must be repository-relative.` });
        }
      }
    }
  }
  for (const name of Object.keys(recipe.runner.environment)) {
    if (/(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_KEY|PRIVATE_KEY)/i.test(name)) {
      context.addIssue({ code: "custom", message: `Environment variable '${name}' may contain a secret; inherit credentials from the approved runtime instead of storing them in the manifest.` });
    }
  }
  if (recipe.readiness?.mode === "probe") {
    for (const name of Object.keys(recipe.readiness.runner.environment)) {
      if (/(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_KEY|PRIVATE_KEY)/i.test(name)) {
        context.addIssue({ code: "custom", message: `Readiness environment variable '${name}' may contain a secret; inherit credentials from the approved runtime instead of storing them in the manifest.` });
      }
    }
  }
  const inputNames = new Set(recipe.inputs.map(({ name }) => name));
  const templates = [
    ...recipe.runner.args,
    ...(recipe.runner.kind === "compose_stage_exec" ? [recipe.runner.workdir, ...recipe.runner.artifacts] : [])
  ];
  for (const template of templates) {
    for (const match of template.matchAll(/\{input:([a-z][a-z0-9_]*)\}/g)) {
      if (!inputNames.has(match[1])) context.addIssue({ code: "custom", message: `Template references unknown input '${match[1]}'.` });
    }
    if (template.includes("{stage}") && recipe.runner.kind !== "compose_stage_exec") {
      context.addIssue({ code: "custom", message: "The {stage} placeholder is only valid for staged Compose tools." });
    }
  }
});

const legacyReviewToolsManifestSchema = z.object({
  schemaVersion: z.literal(1),
  projectRoot: z.string().min(1),
  approvedAt: z.iso.datetime({ offset: true }),
  readinessDefaults: readinessDefaultsSchema.default({ mode: "static" }),
  tools: z.array(reviewToolRecipeSchema).max(200)
});

const runnerPolicySchema = z.object({
  host: z.enum(["allowed", "disallowed"]),
  compose: z.enum(["allowed", "disallowed"]),
  composeExec: z.enum(["allowed", "disallowed"]),
  composeStageExec: z.enum(["allowed", "disallowed"])
});

const validationRequirementSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(2_000),
  requiredWhen: z.string().min(1).max(2_000),
  procedure: z.array(z.string().min(1).max(10_000)).min(1).max(100),
  prerequisites: z.array(z.string().min(1).max(2_000)).max(100).default([]),
  allowedRunners: z.array(z.enum(["host", "compose", "compose_exec", "compose_stage_exec"])).min(1).max(4),
  evidence: z.array(z.string().min(1).max(1_000)).min(1).max(100),
  detectedRequirementIds: z.array(z.string().regex(/^[a-z][a-z0-9_]{1,63}$/)).max(100).default([])
});

const validationCoverageSchema = z.discriminatedUnion("disposition", [
  z.object({
    requirementId: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
    disposition: z.literal("tool"),
    toolIds: z.array(z.string().regex(/^[a-z][a-z0-9_]{1,63}$/)).min(1).max(50)
  }),
  z.object({
    requirementId: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
    disposition: z.literal("gap"),
    reason: z.string().min(1).max(2_000),
    accepted: z.boolean().default(false)
  })
]);

const currentManifestBodySchema = z.object({
  schemaVersion: z.literal(2),
  projectRoot: z.string().min(1),
  detectionSha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
  runnerPolicy: runnerPolicySchema,
  readinessDefaults: readinessDefaultsSchema.default({ mode: "static" }),
  requirements: z.array(validationRequirementSchema).max(500),
  coverage: z.array(validationCoverageSchema).max(500),
  tools: z.array(reviewToolRecipeSchema).max(200)
});

function refineCurrentManifest(
  manifest: z.infer<typeof currentManifestBodySchema>,
  context: z.RefinementCtx
): void {
  const ids = new Set<string>();
  for (const tool of manifest.tools) {
    if (ids.has(tool.id)) context.addIssue({ code: "custom", message: `Duplicate tool id '${tool.id}'.` });
    ids.add(tool.id);
  }
  const requirementIds = new Set<string>();
  for (const requirement of manifest.requirements) {
    if (requirementIds.has(requirement.id)) context.addIssue({ code: "custom", message: `Duplicate validation requirement id '${requirement.id}'.` });
    requirementIds.add(requirement.id);
  }
  const covered = new Set<string>();
  for (const entry of manifest.coverage) {
    if (covered.has(entry.requirementId)) context.addIssue({ code: "custom", message: `Duplicate coverage disposition for '${entry.requirementId}'.` });
    covered.add(entry.requirementId);
  }
}

export const reviewToolsManifestProposalSchema = currentManifestBodySchema.superRefine(refineCurrentManifest);

export const currentReviewToolsManifestSchema = currentManifestBodySchema.extend({
  approvedAt: z.iso.datetime({ offset: true })
}).superRefine(refineCurrentManifest);

export const reviewToolsManifestSchema = z.discriminatedUnion("schemaVersion", [
  legacyReviewToolsManifestSchema.superRefine((manifest, context) => {
    const ids = new Set<string>();
    for (const tool of manifest.tools) {
      if (ids.has(tool.id)) context.addIssue({ code: "custom", message: `Duplicate tool id '${tool.id}'.` });
      ids.add(tool.id);
    }
  }),
  currentReviewToolsManifestSchema
]);

export type ReviewToolInput = z.infer<typeof recipeInputSchema>;
export type ReviewToolRecipe = z.infer<typeof reviewToolRecipeSchema>;
export type ReviewToolsManifest = z.infer<typeof reviewToolsManifestSchema>;
export type ReviewToolsManifestProposal = z.infer<typeof reviewToolsManifestProposalSchema>;
export type CurrentReviewToolsManifest = z.infer<typeof currentReviewToolsManifestSchema>;
export type ReviewToolRunner = ReviewToolRecipe["runner"];
export type ReviewToolReadiness = NonNullable<ReviewToolRecipe["readiness"]>;

export interface CommandSpec {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  label: string;
}

export interface CommandResult {
  label: string;
  command: string;
  args: string[];
  cwd: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
}

export interface ReviewToolExecutionResult {
  success: boolean;
  failureStage?: "prepare" | "copy_source" | "execute" | "artifact_copy" | "cleanup";
  toolId: string;
  runId?: string;
  stagingRoot?: string;
  artifactRoot?: string;
  prepare?: CommandResult;
  copySource?: CommandResult;
  execution?: CommandResult;
  artifactCopies?: Array<{ requestedPath: string; localPath: string; result: CommandResult }>;
  collectedFiles?: Array<{ path: string; size: number; text?: string; contentTruncated?: boolean }>;
  cleanup?: CommandResult;
}

export interface ReviewToolDoctorResult {
  projectRoot: string;
  ready: boolean;
  allReady: boolean;
  tools: Array<{
    id: string;
    status: "ready" | "needs_runtime_probe" | "failed" | "missing";
    basis: "static" | "user_trusted" | "runtime_probe";
    executable: string;
    issues: string[];
    probe?: ReviewToolProbeRecord;
  }>;
}

export interface ReviewToolProbeRecord {
  success: boolean;
  probedAt: string;
  expiresAt: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  error?: string;
}

export interface ReviewToolsProbeResult {
  projectRoot: string;
  results: Record<string, ReviewToolProbeRecord>;
  skipped: Array<{ id: string; reason: string }>;
}

const validationRoot = path.join(runtimeDirectory, "review-tools");
const maxOutputBytes = 256 * 1024;
const textArtifactExtensions = new Set([".csv", ".json", ".jsonl", ".log", ".md", ".txt", ".yaml", ".yml"]);

export function loadBoundProjectRoot(): string {
  const localConfigPath = path.join(reviewerRoot, "bridge.local.json");
  const parsed = JSON.parse(fs.readFileSync(localConfigPath, "utf8")) as { projectRoot?: unknown };
  if (typeof parsed.projectRoot !== "string" || !path.isAbsolute(parsed.projectRoot)) {
    throw new Error("bridge.local.json does not contain an absolute projectRoot.");
  }
  const projectRoot = path.resolve(parsed.projectRoot);
  if (!fs.statSync(projectRoot).isDirectory()) throw new Error(`Bound project root does not exist: ${projectRoot}`);
  return projectRoot;
}

export function loadReviewToolsManifest(
  manifestPath = path.join(reviewerRoot, "review-tools.local.json"),
  projectRoot = loadBoundProjectRoot()
): ReviewToolsManifest {
  if (!fs.existsSync(manifestPath)) throw new Error(`Approved review tool manifest is missing: ${manifestPath}`);
  const manifest = reviewToolsManifestSchema.parse(JSON.parse(fs.readFileSync(manifestPath, "utf8")));
  if (canonical(manifest.projectRoot) !== canonical(projectRoot)) {
    throw new Error(`Review tool manifest is bound to '${manifest.projectRoot}', not '${projectRoot}'.`);
  }
  return manifest;
}

function canonical(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function resolveHostExecutable(command: string, cwd: string): { command: string; argsPrefix: string[] } {
  const requested = validatedCommand(command);
  if (process.platform !== "win32") return { command: requested, argsPrefix: [] };
  const paths = path.isAbsolute(requested) || requested.startsWith("./") || requested.startsWith(".\\")
    ? [path.resolve(cwd, requested)]
    : (spawnSync("where.exe", [requested], { cwd, shell: false, windowsHide: true, encoding: "utf8" }).stdout ?? "")
      .split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
  const native = paths.find((entry) => [".exe", ".com"].includes(path.extname(entry).toLowerCase()));
  if (native) return { command: native, argsPrefix: [] };
  for (const shim of paths.filter((entry) => path.extname(entry).toLowerCase() === ".cmd")) {
    if (!fs.existsSync(shim)) continue;
    const contents = fs.readFileSync(shim, "utf8");
    if (!/node_modules/i.test(contents) || !/%\*/.test(contents)) continue;
    const matches = [...contents.matchAll(/%~?dp0%?\\([^"\r\n]+?\.js)/gi)].map((match) => match[1]);
    const relativeScript = matches.find((entry) => /npm-cli\.js$/i.test(entry)) ?? matches.at(-1);
    if (!relativeScript) continue;
    const script = path.resolve(path.dirname(shim), relativeScript);
    if (!fs.existsSync(script)) continue;
    const adjacentNode = path.join(path.dirname(shim), "node.exe");
    return { command: fs.existsSync(adjacentNode) ? adjacentNode : process.execPath, argsPrefix: [script] };
  }
  throw new Error(`Executable '${requested}' is unavailable without invoking a Windows command shell.`);
}

function executableAvailable(command: string, cwd: string): boolean {
  try {
    if (process.platform !== "win32" && !path.isAbsolute(command) && !command.startsWith("./")) {
      return spawnSync("which", [command], { cwd, shell: false, windowsHide: true, stdio: "ignore" }).status === 0;
    }
    const resolved = resolveHostExecutable(command, cwd);
    return path.isAbsolute(resolved.command) ? fs.existsSync(resolved.command) : true;
  } catch {
    return false;
  }
}

function declaredComposeServices(filename: string): string[] {
  const services: string[] = [];
  let servicesIndent: number | undefined;
  for (const line of fs.readFileSync(filename, "utf8").split(/\r?\n/)) {
    if (servicesIndent === undefined) {
      const match = /^(\s*)services:\s*(?:#.*)?$/.exec(line);
      if (match) servicesIndent = match[1].length;
      continue;
    }
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const indent = /^ */.exec(line)?.[0].length ?? 0;
    if (indent <= servicesIndent) break;
    const match = /^\s*([A-Za-z0-9][A-Za-z0-9_.-]*):\s*(?:#.*)?$/.exec(line);
    if (match && indent === servicesIndent + 2) services.push(match[1]);
  }
  return services;
}

export function doctorReviewTools(
  manifest: ReviewToolsManifest,
  projectRoot = loadBoundProjectRoot(),
  isExecutableAvailable: (command: string, cwd: string) => boolean = executableAvailable,
  probeResults: Record<string, ReviewToolProbeRecord> = {}
): ReviewToolDoctorResult {
  const tools = manifest.tools.map((recipe) => {
    const issues: string[] = [];
    let cwd = projectRoot;
    try {
      cwd = resolveRepositoryDirectory(projectRoot, recipe.runner.cwd);
    } catch (error) {
      issues.push(error instanceof Error ? error.message : String(error));
    }
    let executable = recipe.runner.kind === "host" ? recipe.runner.command : "docker";
    if (!isExecutableAvailable(executable, cwd)) issues.push(`Executable is unavailable on the host PATH: ${executable}`);
    if (recipe.runner.kind !== "host") {
      const declaredServices = new Set<string>();
      for (const composeFile of recipe.runner.files) {
        try {
          const safe = validatedRepositoryPath(projectRoot, composeFile, "Compose file");
          const absolute = path.resolve(projectRoot, ...safe.split("/"));
          if (!fs.existsSync(absolute)) issues.push(`Compose file does not exist: ${safe}`);
          else for (const service of declaredComposeServices(absolute)) declaredServices.add(service);
        } catch (error) {
          issues.push(error instanceof Error ? error.message : String(error));
        }
      }
      if ((recipe.runner.kind === "compose_exec" || recipe.runner.kind === "compose_stage_exec")
          && declaredServices.size > 0 && !declaredServices.has(recipe.runner.service)) {
        issues.push(`Compose service is not declared in the approved files: ${recipe.runner.service}`);
      }
    }
    if (recipe.runner.kind === "compose_stage_exec") {
      const safe = validatedRepositoryPath(projectRoot, recipe.runner.sourceDirectory, "staged source directory");
      if (!fs.existsSync(path.resolve(projectRoot, ...safe.split("/")))) issues.push(`Staged source directory does not exist: ${safe}`);
      executable = `${executable} -> ${recipe.runner.service}:${recipe.runner.command}`;
    } else if (recipe.runner.kind === "compose_exec") {
      executable = `${executable} -> ${recipe.runner.service}:${recipe.runner.command}`;
    }
    const needsRuntimeProbe = recipe.runner.kind === "compose_exec"
      || recipe.runner.kind === "compose_stage_exec"
      || (recipe.runner.kind === "compose" && recipe.runner.args[0] !== "config");
    const readiness = recipe.readiness ?? manifest.readinessDefaults;
    if (readiness.mode === "probe") {
      let probeCwd = projectRoot;
      try {
        probeCwd = resolveRepositoryDirectory(projectRoot, readiness.runner.cwd);
      } catch (error) {
        issues.push(`Readiness probe: ${error instanceof Error ? error.message : String(error)}`);
      }
      const probeExecutable = readiness.runner.kind === "host" ? readiness.runner.command : "docker";
      if (!isExecutableAvailable(probeExecutable, probeCwd)) {
        issues.push(`Readiness probe executable is unavailable on the host PATH: ${probeExecutable}`);
      }
      if (readiness.runner.kind !== "host") {
        const declaredServices = new Set<string>();
        for (const composeFile of readiness.runner.files) {
          try {
            const safe = validatedRepositoryPath(projectRoot, composeFile, "Readiness probe Compose file");
            const absolute = path.resolve(projectRoot, ...safe.split("/"));
            if (!fs.existsSync(absolute)) {
              issues.push(`Readiness probe Compose file does not exist: ${safe}`);
            } else for (const service of declaredComposeServices(absolute)) declaredServices.add(service);
          } catch (error) {
            issues.push(error instanceof Error ? error.message : String(error));
          }
        }
        if (readiness.runner.kind === "compose_exec" && declaredServices.size > 0 && !declaredServices.has(readiness.runner.service)) {
          issues.push(`Readiness probe Compose service is not declared in the approved files: ${readiness.runner.service}`);
        }
      }
    }
    const cachedProbe = probeResults[recipe.id];
    const currentProbe = cachedProbe && Date.parse(cachedProbe.expiresAt) > Date.now() ? cachedProbe : undefined;
    let status: ReviewToolDoctorResult["tools"][number]["status"];
    let basis: ReviewToolDoctorResult["tools"][number]["basis"] = "static";
    if (issues.length) {
      status = "missing";
    } else if (readiness.mode === "trusted") {
      status = "ready";
      basis = "user_trusted";
    } else if (readiness.mode === "probe") {
      basis = "runtime_probe";
      status = currentProbe ? currentProbe.success ? "ready" : "failed" : "needs_runtime_probe";
      if (currentProbe?.error) issues.push(currentProbe.error);
      else if (currentProbe && !currentProbe.success) {
        issues.push(currentProbe.timedOut
          ? "Readiness probe timed out."
          : `Readiness probe exited with code ${currentProbe.exitCode ?? "unknown"}.`);
      }
    } else {
      status = needsRuntimeProbe ? "needs_runtime_probe" : "ready";
    }
    return {
      id: recipe.id,
      status,
      basis,
      executable,
      issues,
      ...(currentProbe ? { probe: currentProbe } : {})
    };
  });
  return {
    projectRoot,
    ready: tools.every(({ status }) => status !== "missing" && status !== "failed"),
    allReady: tools.every(({ status }) => status === "ready"),
    tools
  };
}

export function validatedRepositoryPath(projectRoot: string, rawPath: string, label: string): string {
  const candidate = rawPath.trim().replaceAll("\\", "/");
  if (!candidate || candidate.startsWith("-") || /[\0\r\n]/.test(candidate) || path.posix.isAbsolute(candidate)) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(rawPath)}`);
  }
  const filePart = candidate.split("::", 1)[0];
  const normalizedFile = path.posix.normalize(filePart);
  if (normalizedFile === ".." || normalizedFile.startsWith("../")) {
    throw new Error(`${label} leaves the bound repository: ${rawPath}`);
  }
  const resolved = path.resolve(projectRoot, ...normalizedFile.split("/"));
  const relative = path.relative(projectRoot, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} leaves the bound repository: ${rawPath}`);
  }
  let existing = resolved;
  while (!fs.existsSync(existing) && path.dirname(existing) !== existing) existing = path.dirname(existing);
  if (fs.existsSync(existing)) {
    const realRoot = fs.realpathSync(projectRoot);
    const realExisting = fs.realpathSync(existing);
    const realRelative = path.relative(realRoot, realExisting);
    if (realRelative === ".." || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
      throw new Error(`${label} resolves outside the bound repository: ${rawPath}`);
    }
  }
  return candidate.replace(filePart, normalizedFile);
}

function resolveRepositoryDirectory(projectRoot: string, relativeDirectory: string): string {
  if (relativeDirectory === ".") return projectRoot;
  const safe = validatedRepositoryPath(projectRoot, relativeDirectory, "working directory");
  const absolute = path.resolve(projectRoot, ...safe.split("/"));
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isDirectory()) {
    throw new Error(`Working directory does not exist: ${relativeDirectory}`);
  }
  return absolute;
}

function validatedFixedArgument(argument: string): string {
  if (/[\0\r\n]/.test(argument)) throw new Error("Fixed command arguments cannot contain control characters.");
  return argument;
}

function validatedCommand(command: string): string {
  if (!command.trim() || /[\0\r\n]/.test(command)) throw new Error("Invalid command executable.");
  return command;
}

export function recipeInputObjectSchema(recipe: ReviewToolRecipe): z.ZodObject<Record<string, z.ZodType>> {
  const shape: Record<string, z.ZodType> = {};
  for (const input of recipe.inputs) {
    let field: z.ZodType;
    switch (input.type) {
      case "string": {
        let value = z.string().max(input.maxLength);
        if (input.pattern) value = value.regex(new RegExp(input.pattern));
        field = value;
        break;
      }
      case "enum":
        field = z.enum(input.values as [string, ...string[]]);
        break;
      case "integer": {
        let value = z.number().int();
        if (input.minimum !== undefined) value = value.min(input.minimum);
        if (input.maximum !== undefined) value = value.max(input.maximum);
        field = value;
        break;
      }
      case "boolean":
        field = z.boolean();
        break;
      case "repo_paths":
        field = z.array(z.string().min(1).max(1_000)).max(input.maxItems);
        break;
      case "strings":
        field = z.array(z.string().max(input.itemMaxLength)).max(input.maxItems);
        break;
    }
    field = field.describe(input.description);
    if ("default" in input && input.default !== undefined) field = field.default(input.default);
    else if (!input.required) field = field.optional();
    shape[input.name] = field;
  }
  return z.object(shape);
}

function normalizedInputValues(recipe: ReviewToolRecipe, raw: Record<string, unknown>, projectRoot: string): Record<string, unknown> {
  const parsed = recipeInputObjectSchema(recipe).parse(raw);
  const values: Record<string, unknown> = {};
  for (const input of recipe.inputs) {
    const value = parsed[input.name];
    if (value === undefined) continue;
    if (input.type === "repo_paths") {
      const entries = value as string[];
      if (input.required && entries.length === 0) throw new Error(`Input '${input.name}' requires at least one repository path.`);
      values[input.name] = entries.map((entry) => {
        const safe = validatedRepositoryPath(projectRoot, entry, `input '${input.name}'`);
        const filePart = safe.split("::", 1)[0];
        if (input.allowedPrefixes.length) {
          const allowed = input.allowedPrefixes.some((prefix) => {
            const normalized = path.posix.normalize(prefix.replaceAll("\\", "/")).replace(/\/$/, "");
            return filePart === normalized || filePart.startsWith(`${normalized}/`);
          });
          if (!allowed) throw new Error(`Input '${input.name}' is outside its approved repository prefixes: ${entry}`);
        }
        if (input.extensions.length && !input.extensions.some((extension) => filePart.toLowerCase().endsWith(extension.toLowerCase()))) {
          throw new Error(`Input '${input.name}' does not use an approved extension: ${entry}`);
        }
        if (input.pathKind !== "any") {
          const absolute = path.resolve(projectRoot, ...filePart.split("/"));
          if (!fs.existsSync(absolute)) throw new Error(`Input '${input.name}' does not exist: ${entry}`);
          const matchesKind = input.pathKind === "file" ? fs.statSync(absolute).isFile() : fs.statSync(absolute).isDirectory();
          if (!matchesKind) throw new Error(`Input '${input.name}' is not an approved ${input.pathKind}: ${entry}`);
        }
        return safe;
      });
    } else if (input.type === "strings") {
      values[input.name] = (value as string[]).map((entry) => {
        if (/[\0\r\n]/.test(entry)) throw new Error(`Input '${input.name}' cannot contain control characters.`);
        return entry;
      });
    } else if (typeof value === "string") {
      if (/[\0\r\n]/.test(value)) throw new Error(`Input '${input.name}' cannot contain control characters.`);
      values[input.name] = value;
    } else {
      values[input.name] = value;
    }
  }
  return values;
}

function renderValue(template: string, value: string, stage: string | undefined): string {
  const rendered = template.replaceAll("{value}", value).replaceAll("{stage}", stage ?? "{stage}");
  if (rendered.includes("{stage}")) throw new Error("The {stage} placeholder is only valid for staged Compose tools.");
  return rendered;
}

function renderTemplate(template: string, values: Record<string, unknown>, stage: string | undefined): string {
  let rendered = template.replaceAll("{stage}", stage ?? "{stage}");
  rendered = rendered.replace(/\{input:([a-z][a-z0-9_]*)\}/g, (_match, name: string) => {
    const value = values[name];
    if (typeof value !== "string" && typeof value !== "number") throw new Error(`Template input '${name}' is unavailable.`);
    return String(value);
  });
  if (/\{(?:stage|input:)/.test(rendered)) throw new Error(`Unresolved command template: ${template}`);
  return rendered;
}

function boundArguments(recipe: ReviewToolRecipe, values: Record<string, unknown>, stage?: string): string[] {
  const args: string[] = [];
  for (const input of recipe.inputs) {
    const value = values[input.name];
    if (value === undefined || value === false) continue;
    if (input.type === "boolean") {
      args.push(input.flag!);
      continue;
    }
    const entries = Array.isArray(value) ? value : [value];
    if (!entries.length) continue;
    if (input.flag) args.push(input.flag);
    for (const entry of entries) {
      const text = String(entry);
      args.push(input.valueTemplate ? renderValue(input.valueTemplate, text, stage) : text);
    }
  }
  return args;
}

function commandEnvironment(runner: ReviewToolRunner): NodeJS.ProcessEnv {
  const temporary = path.join(validationRoot, "tmp");
  const uvCache = path.join(validationRoot, "uv-cache");
  const ruffCache = path.join(validationRoot, "ruff-cache");
  for (const directory of [temporary, uvCache, ruffCache]) fs.mkdirSync(directory, { recursive: true });
  return {
    ...process.env,
    TEMP: temporary,
    TMP: temporary,
    UV_CACHE_DIR: uvCache,
    RUFF_CACHE_DIR: ruffCache,
    PYTHONDONTWRITEBYTECODE: "1",
    ...runner.environment
  };
}

function composeFileArguments(projectRoot: string, files: string[]): string[] {
  const args: string[] = [];
  for (const file of files) {
    const safe = validatedRepositoryPath(projectRoot, file, "Compose file");
    args.push("-f", safe);
  }
  return args;
}

export function recipeCommand(
  recipe: ReviewToolRecipe,
  rawInputs: Record<string, unknown>,
  projectRoot = loadBoundProjectRoot(),
  stage?: string
): CommandSpec {
  const values = normalizedInputValues(recipe, rawInputs, projectRoot);
  const runner = recipe.runner;
  const fixedArgs = runner.args.map(validatedFixedArgument).map((argument) => renderTemplate(argument, values, stage));
  const dynamicArgs = boundArguments(recipe, values, stage);
  const cwd = resolveRepositoryDirectory(projectRoot, runner.cwd);
  const common = {
    cwd,
    env: commandEnvironment(runner),
    timeoutMs: recipe.timeoutSeconds * 1_000,
    label: recipe.id
  };
  switch (runner.kind) {
    case "host":
      {
        const executable = resolveHostExecutable(runner.command, cwd);
        return { command: executable.command, args: [...executable.argsPrefix, ...fixedArgs, ...dynamicArgs], ...common };
      }
    case "compose":
      return {
        command: "docker",
        args: ["compose", ...composeFileArguments(projectRoot, runner.files), ...fixedArgs, ...dynamicArgs],
        ...common
      };
    case "compose_exec":
      return {
        command: "docker",
        args: [
          "compose", ...composeFileArguments(projectRoot, runner.files), "exec", "-T",
          ...Object.entries(runner.environment).flatMap(([name, value]) => ["-e", `${name}=${value}`]),
          ...(runner.workdir ? ["-w", runner.workdir] : []), runner.service,
          validatedCommand(runner.command), ...fixedArgs, ...dynamicArgs
        ],
        ...common
      };
    case "compose_stage_exec":
      if (!stage) throw new Error("Staged Compose commands require a staging root.");
      return {
        command: "docker",
        args: [
          "compose", ...composeFileArguments(projectRoot, runner.files), "exec", "-T",
          ...Object.entries(runner.environment).flatMap(([name, value]) => ["-e", `${name}=${value}`]),
          "-w", renderTemplate(runner.workdir, values, stage), runner.service,
          validatedCommand(runner.command), ...fixedArgs, ...dynamicArgs
        ],
        ...common
      };
  }
}

export async function runCommand(spec: CommandSpec): Promise<CommandResult> {
  const started = performance.now();
  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: spec.env ?? process.env,
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let outputTruncated = false;
  const append = (current: string, currentBytes: number, chunk: Buffer): { text: string; bytes: number } => {
    if (currentBytes >= maxOutputBytes) {
      outputTruncated = true;
      return { text: current, bytes: currentBytes };
    }
    const available = maxOutputBytes - currentBytes;
    if (chunk.length > available) outputTruncated = true;
    const accepted = chunk.subarray(0, available);
    return { text: current + accepted.toString("utf8"), bytes: currentBytes + accepted.length };
  };
  child.stdout.on("data", (chunk: Buffer) => {
    const next = append(stdout, stdoutBytes, chunk);
    stdout = next.text;
    stdoutBytes = next.bytes;
  });
  child.stderr.on("data", (chunk: Buffer) => {
    const next = append(stderr, stderrBytes, chunk);
    stderr = next.text;
    stderrBytes = next.bytes;
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    terminate(child);
  }, spec.timeoutMs);
  const { exitCode, signal } = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, closeSignal) => resolve({ exitCode: code, signal: closeSignal }));
  }).finally(() => clearTimeout(timer));
  return {
    label: spec.label,
    command: spec.command,
    args: [...spec.args],
    cwd: spec.cwd,
    exitCode,
    signal,
    timedOut,
    durationMs: Math.round(performance.now() - started),
    stdout,
    stderr,
    outputTruncated
  };
}

function terminate(child: ChildProcess): void {
  if (child.pid && process.platform === "win32") {
    const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
      shell: false,
      windowsHide: true,
      stdio: "ignore"
    });
    killer.unref();
    return;
  }
  child.kill("SIGTERM");
}

function commandSucceeded(result: CommandResult | undefined): boolean {
  return result?.exitCode === 0 && !result.timedOut;
}

export class SingleReviewToolRunner {
  private active?: string;

  async runExclusive<T>(label: string, task: () => Promise<T>): Promise<T> {
    if (this.active) throw new Error(`Review tool '${this.active}' is already running.`);
    this.active = label;
    try {
      return await task();
    } finally {
      this.active = undefined;
    }
  }
}

export async function probeReviewTools(
  singleRunner: SingleReviewToolRunner,
  manifest: ReviewToolsManifest,
  toolIds: string[] | undefined,
  projectRoot = loadBoundProjectRoot()
): Promise<ReviewToolsProbeResult> {
  const recipes = new Map(manifest.tools.map((recipe) => [recipe.id, recipe]));
  const selectedIds = toolIds ?? manifest.tools
    .filter((recipe) => (recipe.readiness ?? manifest.readinessDefaults).mode === "probe")
    .map((recipe) => recipe.id);
  const duplicate = selectedIds.find((id, index) => selectedIds.indexOf(id) !== index);
  if (duplicate) throw new Error(`Readiness tool id was selected more than once: ${duplicate}`);
  const unknown = selectedIds.find((id) => !recipes.has(id));
  if (unknown) throw new Error(`Unknown approved review tool id: ${unknown}`);

  const results: Record<string, ReviewToolProbeRecord> = {};
  const skipped: ReviewToolsProbeResult["skipped"] = [];
  for (const id of selectedIds) {
    const recipe = recipes.get(id)!;
    const readiness = recipe.readiness ?? manifest.readinessDefaults;
    if (readiness.mode !== "probe") {
      skipped.push({ id, reason: `Readiness mode is '${readiness.mode}', so no runtime probe is configured.` });
      continue;
    }
    const probeRecipe = reviewToolRecipeSchema.parse({
      id: recipe.id,
      title: recipe.title,
      description: `Probe readiness for ${recipe.title}.`,
      runner: readiness.runner,
      timeoutSeconds: readiness.timeoutSeconds,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      evidence: recipe.evidence
    });
    const probedAt = new Date();
    try {
      const execution = await singleRunner.runExclusive(`readiness:${recipe.id}`, async () => (
        runCommand(recipeCommand(probeRecipe, {}, projectRoot))
      ));
      results[id] = {
        success: commandSucceeded(execution),
        probedAt: probedAt.toISOString(),
        expiresAt: new Date(probedAt.getTime() + readiness.cacheSeconds * 1_000).toISOString(),
        exitCode: execution.exitCode,
        timedOut: execution.timedOut,
        durationMs: execution.durationMs
      };
    } catch (error) {
      results[id] = {
        success: false,
        probedAt: probedAt.toISOString(),
        expiresAt: new Date(probedAt.getTime() + readiness.cacheSeconds * 1_000).toISOString(),
        exitCode: null,
        timedOut: false,
        durationMs: 0,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }
  return { projectRoot, results, skipped };
}

function collectArtifactFiles(artifactRoot: string): NonNullable<ReviewToolExecutionResult["collectedFiles"]> {
  if (!fs.existsSync(artifactRoot)) return [];
  const collected: NonNullable<ReviewToolExecutionResult["collectedFiles"]> = [];
  const visit = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) {
        const size = fs.statSync(absolute).size;
        const item: NonNullable<ReviewToolExecutionResult["collectedFiles"]>[number] = {
          path: path.relative(artifactRoot, absolute).replaceAll("\\", "/"),
          size
        };
        if (textArtifactExtensions.has(path.extname(entry.name).toLowerCase())) {
          const content = fs.readFileSync(absolute);
          item.text = content.subarray(0, maxOutputBytes).toString("utf8");
          item.contentTruncated = content.length > maxOutputBytes;
        }
        collected.push(item);
      }
    }
  };
  visit(artifactRoot);
  return collected;
}

export async function executeReviewTool(
  singleRunner: SingleReviewToolRunner,
  recipe: ReviewToolRecipe,
  rawInputs: Record<string, unknown>,
  projectRoot = loadBoundProjectRoot()
): Promise<ReviewToolExecutionResult> {
  if (recipe.runner.kind !== "compose_stage_exec") {
    return singleRunner.runExclusive(recipe.id, async () => {
      const execution = await runCommand(recipeCommand(recipe, rawInputs, projectRoot));
      return { success: commandSucceeded(execution), failureStage: commandSucceeded(execution) ? undefined : "execute", toolId: recipe.id, execution };
    });
  }

  const stageRunner = recipe.runner;
  const values = normalizedInputValues(recipe, rawInputs, projectRoot);
  const runId = crypto.randomUUID();
  const stagingRoot = `/tmp/review-tools/${runId}/repo`;
  const artifactRoot = path.join(validationRoot, "artifacts", runId);
  const sourceDirectory = validatedRepositoryPath(projectRoot, stageRunner.sourceDirectory, "staged source directory");
  const hostSource = path.resolve(projectRoot, ...sourceDirectory.split("/"));
  if (!fs.existsSync(hostSource) || !fs.statSync(hostSource).isDirectory()) {
    throw new Error(`Staged source directory does not exist: ${sourceDirectory}`);
  }
  const relativeRealSource = path.relative(fs.realpathSync(projectRoot), fs.realpathSync(hostSource));
  if (relativeRealSource === ".." || relativeRealSource.startsWith(`..${path.sep}`) || path.isAbsolute(relativeRealSource)) {
    throw new Error(`Staged source directory resolves outside the bound repository: ${sourceDirectory}`);
  }
  const stagedSource = `${stagingRoot}/${sourceDirectory}`;
  const composeArgs = composeFileArguments(projectRoot, stageRunner.files);
  const internalSpec = (args: string[], timeoutMs: number, label: string): CommandSpec => ({
    command: "docker",
    args: ["compose", ...composeArgs, ...args],
    cwd: resolveRepositoryDirectory(projectRoot, stageRunner.cwd),
    timeoutMs,
    label
  });
  const prepareSpec = internalSpec(["exec", "-T", stageRunner.service, "mkdir", "-p", path.posix.dirname(stagedSource)], 120_000, `${recipe.id}:prepare`);
  const copySourceSpec = internalSpec(["cp", sourceDirectory, `${stageRunner.service}:${stagedSource}`], 300_000, `${recipe.id}:copy_source`);
  const executeSpec = recipeCommand(recipe, rawInputs, projectRoot, stagingRoot);
  const cleanupSpec = internalSpec(["exec", "-T", stageRunner.service, "rm", "-rf", `/tmp/review-tools/${runId}`], 120_000, `${recipe.id}:cleanup`);
  const artifacts = stageRunner.artifacts.map((template) => {
    const requestedPath = validatedRepositoryPath(projectRoot, renderTemplate(template, values, stagingRoot), "artifact path");
    if (requestedPath !== sourceDirectory && !requestedPath.startsWith(`${sourceDirectory}/`)) {
      throw new Error(`Artifact path must stay under '${sourceDirectory}': ${requestedPath}`);
    }
    const localPath = path.join(artifactRoot, ...requestedPath.split("/"));
    return {
      requestedPath,
      localPath,
      spec: internalSpec(["cp", `${stageRunner.service}:${stagingRoot}/${requestedPath}`, localPath], 300_000, `${recipe.id}:artifact`)
    };
  });

  return singleRunner.runExclusive(recipe.id, async () => {
    fs.mkdirSync(artifactRoot, { recursive: true });
    let prepare!: CommandResult;
    let copySource: CommandResult | undefined;
    let execution: CommandResult | undefined;
    const artifactCopies: NonNullable<ReviewToolExecutionResult["artifactCopies"]> = [];
    let cleanup!: CommandResult;
    try {
      prepare = await runCommand(prepareSpec);
      if (commandSucceeded(prepare)) copySource = await runCommand(copySourceSpec);
      if (commandSucceeded(copySource)) execution = await runCommand(executeSpec);
      if (execution) {
        for (const artifact of artifacts) {
          fs.mkdirSync(path.dirname(artifact.localPath), { recursive: true });
          artifactCopies.push({ requestedPath: artifact.requestedPath, localPath: artifact.localPath, result: await runCommand(artifact.spec) });
        }
      }
    } finally {
      cleanup = await runCommand(cleanupSpec);
    }
    const failureStage = !commandSucceeded(prepare)
      ? "prepare"
      : !commandSucceeded(copySource)
        ? "copy_source"
        : !commandSucceeded(execution)
          ? "execute"
          : artifactCopies.some(({ result }) => !commandSucceeded(result))
            ? "artifact_copy"
            : !commandSucceeded(cleanup)
              ? "cleanup"
              : undefined;
    return {
      success: failureStage === undefined,
      failureStage,
      toolId: recipe.id,
      runId,
      stagingRoot,
      artifactRoot,
      prepare,
      copySource,
      execution,
      artifactCopies,
      collectedFiles: collectArtifactFiles(artifactRoot),
      cleanup
    };
  });
}
