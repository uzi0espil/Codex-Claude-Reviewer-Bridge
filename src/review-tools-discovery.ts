import fs from "node:fs";
import path from "node:path";
import { reviewToolRecipeSchema, type ReviewToolRecipe } from "./review-tools.js";

export interface DetectedReviewTool {
  confidence: "high" | "medium";
  rationale: string;
  recipe: ReviewToolRecipe;
}

export interface DetectedValidationRequirement {
  id: string;
  title: string;
  description: string;
  source: string;
  requiredWhen: string;
  command: string;
  cwd: string;
  services: string[];
  role: "validation" | "support";
}

export interface ReviewToolDiscovery {
  schemaVersion: 2;
  projectRoot: string;
  generatedAt: string;
  technologies: Array<{ id: string; evidence: string[] }>;
  requirements: DetectedValidationRequirement[];
  candidates: DetectedReviewTool[];
  questions: string[];
}

const ignoredDirectories = new Set([
  ".git", ".idea", ".mypy_cache", ".next", ".pytest_cache", ".ruff_cache", ".tox", ".venv",
  ".vscode", "build", "coverage", "dist", "node_modules", "target", "vendor"
]);
const validationName = /(?:^|[-_.:])(test|tests|lint|check|verify|validate|validation|audit|benchmark|smoke|typecheck|coverage|build)(?:$|[-_.:])/i;
const ciValidationText = /\b(test|tests|pytest|vitest|jest|ruff|eslint|lint|format|typecheck|type-check|check|verify|validate|audit|benchmark|smoke|coverage|build|doctor|guard|parity|migration|migrate|backup|restore|knip|jscpd|react-doctor|schema|chain|bootstrap|round-trip|fails|failure|liveness)\b/i;
const ciSupportStepName = /^(?:install|set up|setup|start|free disk|checkout|download|upload)\b/i;

function relativePath(root: string, absolute: string): string {
  const relative = path.relative(root, absolute).replaceAll("\\", "/");
  return relative || ".";
}

function walk(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) visit(absolute);
      } else if (entry.isFile()) {
        files.push(absolute);
      }
    }
  };
  visit(root);
  return files;
}

function slug(value: string): string {
  const result = value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const safe = result && /^[a-z]/.test(result) ? result : `x_${result || "root"}`;
  return safe.slice(0, 28);
}

function title(value: string): string {
  return value.replaceAll(/[-_:]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function readText(filename: string): string {
  return fs.readFileSync(filename, "utf8");
}

function packageManager(directory: string): { command: string; args: string[]; evidence?: string } {
  if (fs.existsSync(path.join(directory, "pnpm-lock.yaml"))) return { command: "pnpm", args: ["run"], evidence: "pnpm-lock.yaml" };
  if (fs.existsSync(path.join(directory, "yarn.lock"))) return { command: "yarn", args: [], evidence: "yarn.lock" };
  if (fs.existsSync(path.join(directory, "bun.lock")) || fs.existsSync(path.join(directory, "bun.lockb"))) {
    return { command: "bun", args: ["run"], evidence: fs.existsSync(path.join(directory, "bun.lock")) ? "bun.lock" : "bun.lockb" };
  }
  return { command: "npm", args: ["run"], evidence: fs.existsSync(path.join(directory, "package-lock.json")) ? "package-lock.json" : undefined };
}

function composeServices(contents: string): string[] {
  const services: string[] = [];
  let inside = false;
  for (const line of contents.split(/\r?\n/)) {
    if (/^services:\s*(?:#.*)?$/.test(line)) {
      inside = true;
      continue;
    }
    if (!inside) continue;
    if (/^[^\s#]/.test(line)) break;
    const match = /^  ([A-Za-z0-9][A-Za-z0-9_.-]*):\s*(?:#.*)?$/.exec(line);
    if (match) services.push(match[1]);
  }
  return services;
}

function indentation(line: string): number {
  return /^ */.exec(line)?.[0].length ?? 0;
}

function unquoteYamlScalar(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function githubWorkflowRequirements(root: string, filename: string): DetectedValidationRequirement[] {
  const relative = relativePath(root, filename);
  const lines = readText(filename).split(/\r?\n/);
  const requirements: DetectedValidationRequirement[] = [];
  const jobsIndex = lines.findIndex((line) => /^jobs:\s*(?:#.*)?$/.test(line));
  if (jobsIndex < 0) return requirements;

  const jobStarts: Array<{ index: number; id: string; indent: number }> = [];
  for (let index = jobsIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() && indentation(line) === 0) break;
    const match = /^(\s+)([A-Za-z0-9_-]+):\s*(?:#.*)?$/.exec(line);
    if (match && match[1].length === 2) jobStarts.push({ index, id: match[2], indent: match[1].length });
  }

  for (let jobPosition = 0; jobPosition < jobStarts.length; jobPosition += 1) {
    const job = jobStarts[jobPosition];
    const end = jobStarts[jobPosition + 1]?.index ?? lines.length;
    const jobLines = lines.slice(job.index + 1, end);
    const jobIf = jobLines
      .map((line) => ({ line, indent: indentation(line) }))
      .find(({ line, indent }) => indent === job.indent + 2 && /^\s*if:\s*/.test(line));
    const services: string[] = [];
    const serviceStart = jobLines.findIndex((line) => indentation(line) === job.indent + 2 && /^\s*services:\s*(?:#.*)?$/.test(line));
    if (serviceStart >= 0) {
      for (let offset = serviceStart + 1; offset < jobLines.length; offset += 1) {
        const line = jobLines[offset];
        const indent = indentation(line);
        if (line.trim() && indent <= job.indent + 2) break;
        const match = /^\s+([A-Za-z0-9_.-]+):\s*(?:#.*)?$/.exec(line);
        if (match && indent === job.indent + 4) services.push(match[1]);
      }
    }

    const stepsStart = jobLines.findIndex((line) => indentation(line) === job.indent + 2 && /^\s*steps:\s*(?:#.*)?$/.test(line));
    if (stepsStart < 0) continue;
    const stepStarts: number[] = [];
    for (let offset = stepsStart + 1; offset < jobLines.length; offset += 1) {
      const line = jobLines[offset];
      if (line.trim() && indentation(line) <= job.indent + 2) break;
      if (/^\s*-\s+/.test(line) && indentation(line) === job.indent + 4) stepStarts.push(offset);
    }
    for (let stepPosition = 0; stepPosition < stepStarts.length; stepPosition += 1) {
      const start = stepStarts[stepPosition];
      const stepEnd = stepStarts[stepPosition + 1] ?? jobLines.length;
      const stepLines = jobLines.slice(start, stepEnd);
      const stepIndent = job.indent + 4;
      let name = `Step ${stepPosition + 1}`;
      let stepIf: string | undefined;
      let cwd = ".";
      let command = "";
      for (let offset = 0; offset < stepLines.length; offset += 1) {
        const line = stepLines[offset];
        const normalized = offset === 0 ? line.replace(/^\s*-\s+/, "") : line.trimStart();
        const nameMatch = /^name:\s*(.+)$/.exec(normalized);
        if (nameMatch) name = unquoteYamlScalar(nameMatch[1]);
        const ifMatch = /^if:\s*(.+)$/.exec(normalized);
        if (ifMatch) stepIf = unquoteYamlScalar(ifMatch[1]);
        const cwdMatch = /^working-directory:\s*(.+)$/.exec(normalized);
        if (cwdMatch) cwd = unquoteYamlScalar(cwdMatch[1]);
        const runMatch = /^run:\s*(.*)$/.exec(normalized);
        if (!runMatch) continue;
        const inline = runMatch[1].trim();
        if (inline && inline !== "|" && inline !== ">" && inline !== "|-" && inline !== ">-") {
          command = unquoteYamlScalar(inline);
          continue;
        }
        const runIndent = indentation(line);
        const block: string[] = [];
        for (let blockOffset = offset + 1; blockOffset < stepLines.length; blockOffset += 1) {
          const blockLine = stepLines[blockOffset];
          if (blockLine.trim() && indentation(blockLine) <= runIndent) break;
          block.push(blockLine.slice(Math.min(blockLine.length, runIndent + 2)));
          offset = blockOffset;
        }
        command = block.join("\n").trim();
      }
      if (!command) continue;
      const baseId = `ci_${slug(relative)}_${slug(job.id)}_${slug(name)}`.slice(0, 64).replace(/_+$/, "");
      let id = baseId;
      let suffix = 2;
      while (requirements.some((entry) => entry.id === id)) id = `${baseId.slice(0, 61)}_${suffix++}`;
      const conditions = [jobIf?.line.replace(/^\s*if:\s*/, ""), stepIf].filter(Boolean);
      requirements.push({
        id,
        title: `${name} (${job.id})`,
        description: `Validation-like GitHub Actions step '${name}' in job '${job.id}'. Preserve its command, setup, services, conditions, and working directory when curating a local capability.`,
        source: `${relative}#jobs.${job.id}.steps.${stepPosition + 1}`,
        requiredWhen: conditions.length ? conditions.join(" and ") : `When GitHub Actions job '${job.id}' is selected by its workflow triggers`,
        command,
        cwd,
        services: [...new Set(services)].sort(),
        role: !ciSupportStepName.test(name) && ciValidationText.test(`${name}\n${command}`) ? "validation" : "support"
      });
    }
  }
  return requirements;
}

export function discoverReviewTools(projectRoot: string): ReviewToolDiscovery {
  const root = path.resolve(projectRoot);
  const files = walk(root);
  const byBasename = new Map<string, string[]>();
  for (const filename of files) {
    const entries = byBasename.get(path.basename(filename)) ?? [];
    entries.push(filename);
    byBasename.set(path.basename(filename), entries);
  }
  const technologies = new Map<string, Set<string>>();
  const candidates = new Map<string, DetectedReviewTool>();

  const technology = (id: string, evidence: string): void => {
    const entries = technologies.get(id) ?? new Set<string>();
    entries.add(evidence);
    technologies.set(id, entries);
  };
  const add = (confidence: "high" | "medium", rationale: string, candidate: unknown): void => {
    const recipe = reviewToolRecipeSchema.parse(candidate);
    let id = recipe.id;
    let suffix = 2;
    while (candidates.has(id)) id = `${recipe.id.slice(0, 60)}_${suffix++}`;
    candidates.set(id, { confidence, rationale, recipe: { ...recipe, id } });
  };

  for (const packageFile of byBasename.get("package.json") ?? []) {
    const directory = path.dirname(packageFile);
    const relativeDirectory = relativePath(root, directory);
    let metadata: { scripts?: Record<string, unknown> };
    try {
      metadata = JSON.parse(readText(packageFile)) as { scripts?: Record<string, unknown> };
    } catch {
      continue;
    }
    technology("javascript-typescript", relativePath(root, packageFile));
    const manager = packageManager(directory);
    if (manager.evidence) technology("javascript-typescript", relativePath(root, path.join(directory, manager.evidence)));
    for (const [name, body] of Object.entries(metadata.scripts ?? {})) {
      if (typeof body !== "string" || !validationName.test(name)) continue;
      add("high", "Declared package-manager script; the script body remains owned by the package manifest.", {
        id: `${slug(relativeDirectory)}_${slug(name)}`,
        title: `${title(name)} (${relativeDirectory})`,
        description: `Run the '${name}' package script in ${relativeDirectory}.`,
        runner: { kind: "host", command: manager.command, args: [...manager.args, name], cwd: relativeDirectory },
        timeoutSeconds: /build|coverage|test/i.test(name) ? 1_800 : 600,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        evidence: [`${relativePath(root, packageFile)}#scripts.${name}`]
      });
    }
  }

  for (const composerFile of byBasename.get("composer.json") ?? []) {
    const directory = path.dirname(composerFile);
    const relativeDirectory = relativePath(root, directory);
    let metadata: { scripts?: Record<string, unknown> };
    try {
      metadata = JSON.parse(readText(composerFile)) as { scripts?: Record<string, unknown> };
    } catch {
      continue;
    }
    technology("php-composer", relativePath(root, composerFile));
    for (const [name, body] of Object.entries(metadata.scripts ?? {})) {
      if ((!Array.isArray(body) && typeof body !== "string") || !validationName.test(name)) continue;
      add("high", "Declared Composer script; the script body remains owned by composer.json.", {
        id: `${slug(relativeDirectory)}_composer_${slug(name)}`,
        title: `${title(name)} (${relativeDirectory})`,
        description: `Run the '${name}' Composer script in ${relativeDirectory}.`,
        runner: { kind: "host", command: "composer", args: ["run-script", name], cwd: relativeDirectory },
        timeoutSeconds: 1_800,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        evidence: [`${relativePath(root, composerFile)}#scripts.${name}`]
      });
    }
  }

  for (const gemfile of byBasename.get("Gemfile") ?? []) {
    const directory = path.dirname(gemfile);
    const relativeDirectory = relativePath(root, directory);
    technology("ruby-bundler", relativePath(root, gemfile));
    const rakefile = path.join(directory, "Rakefile");
    if (fs.existsSync(rakefile) && /(?:task\s+[:'\"]test|Rake::TestTask)/.test(readText(rakefile))) {
      add("high", "Bundler project with a Rake test task detected.", {
        id: `${slug(relativeDirectory)}_rake_test`, title: `Rake Test (${relativeDirectory})`,
        description: `Run the Rake test task in ${relativeDirectory}.`, runner: { kind: "host", command: "bundle", args: ["exec", "rake", "test"], cwd: relativeDirectory },
        timeoutSeconds: 1_800, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        evidence: [relativePath(root, gemfile), relativePath(root, rakefile)]
      });
    }
  }

  for (const makefile of byBasename.get("Makefile") ?? []) {
    const relativeDirectory = relativePath(root, path.dirname(makefile));
    technology("make", relativePath(root, makefile));
    for (const line of readText(makefile).split(/\r?\n/)) {
      const match = /^([A-Za-z0-9][A-Za-z0-9_.-]*):(?:\s|$)/.exec(line);
      if (!match || !validationName.test(match[1])) continue;
      add("medium", "Validation-like Make target detected; confirm its prerequisites and side effects.", {
        id: `${slug(relativeDirectory)}_make_${slug(match[1])}`, title: `Make ${match[1]} (${relativeDirectory})`,
        description: `Run the '${match[1]}' Make target in ${relativeDirectory}.`, runner: { kind: "host", command: "make", args: [match[1]], cwd: relativeDirectory },
        timeoutSeconds: 1_800, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }, evidence: [relativePath(root, makefile)]
      });
    }
  }

  for (const justfile of [...(byBasename.get("Justfile") ?? []), ...(byBasename.get("justfile") ?? [])]) {
    const relativeDirectory = relativePath(root, path.dirname(justfile));
    technology("just", relativePath(root, justfile));
    for (const line of readText(justfile).split(/\r?\n/)) {
      const match = /^([A-Za-z_][A-Za-z0-9_-]*)(?:\s[^:=]*)?:\s*(?:#.*)?$/.exec(line);
      if (!match || !validationName.test(match[1])) continue;
      add("medium", "Validation-like Just recipe detected; confirm its prerequisites and side effects.", {
        id: `${slug(relativeDirectory)}_just_${slug(match[1])}`, title: `Just ${match[1]} (${relativeDirectory})`,
        description: `Run the '${match[1]}' Just recipe in ${relativeDirectory}.`, runner: { kind: "host", command: "just", args: [match[1]], cwd: relativeDirectory },
        timeoutSeconds: 1_800, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }, evidence: [relativePath(root, justfile)]
      });
    }
  }

  for (const pyproject of byBasename.get("pyproject.toml") ?? []) {
    const directory = path.dirname(pyproject);
    const relativeDirectory = relativePath(root, directory);
    const contents = readText(pyproject);
    technology("python", relativePath(root, pyproject));
    const hasUv = fs.existsSync(path.join(directory, "uv.lock")) || fs.existsSync(path.join(root, "uv.lock"));
    if (hasUv) technology("python-uv", relativePath(root, fs.existsSync(path.join(directory, "uv.lock")) ? path.join(directory, "uv.lock") : path.join(root, "uv.lock")));
    const launcher = hasUv ? { command: "uv", prefix: ["run", "--frozen", "--no-sync"] } : { command: "python", prefix: ["-m"] };
    if (/pytest|\[tool\.pytest/.test(contents)) {
      add("high", "Pytest is declared by the Python project configuration.", {
        id: `${slug(relativeDirectory)}_pytest`,
        title: `Pytest (${relativeDirectory})`,
        description: `Run pytest for the Python project in ${relativeDirectory}. Optional targets must remain in the repository.`,
        runner: { kind: "host", command: launcher.command, args: [...launcher.prefix, "pytest"], cwd: relativeDirectory },
        inputs: [{ name: "targets", description: "Optional repository-relative pytest paths or node ids.", type: "repo_paths" }],
        timeoutSeconds: 1_800,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        evidence: [relativePath(root, pyproject)]
      });
    }
    if (/ruff|\[tool\.ruff/.test(contents)) {
      add("high", "Ruff is declared by the Python project configuration.", {
        id: `${slug(relativeDirectory)}_ruff_check`,
        title: `Ruff Check (${relativeDirectory})`,
        description: `Run Ruff checks for the Python project in ${relativeDirectory}.`,
        runner: { kind: "host", command: launcher.command, args: [...launcher.prefix, "ruff", "check", "."], cwd: relativeDirectory },
        timeoutSeconds: 600,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        evidence: [relativePath(root, pyproject)]
      });
    }
    if (/\[tool\.importlinter\]/.test(contents)) {
      add("high", "Import-linter contracts are declared by the Python project configuration.", {
        id: `${slug(relativeDirectory)}_import_lint`,
        title: `Import Contracts (${relativeDirectory})`,
        description: `Run import-linter contracts for ${relativeDirectory}.`,
        runner: { kind: "host", command: hasUv ? "uv" : "lint-imports", args: hasUv ? ["run", "--frozen", "--no-sync", "lint-imports"] : [], cwd: relativeDirectory },
        timeoutSeconds: 600,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        evidence: [relativePath(root, pyproject)]
      });
    }
  }

  for (const cargo of byBasename.get("Cargo.toml") ?? []) {
    const relativeDirectory = relativePath(root, path.dirname(cargo));
    technology("rust", relativePath(root, cargo));
    add("high", "Cargo manifest detected.", {
      id: `${slug(relativeDirectory)}_cargo_test`, title: `Cargo Test (${relativeDirectory})`,
      description: `Run Cargo tests in ${relativeDirectory}.`,
      runner: { kind: "host", command: "cargo", args: ["test", "--workspace"], cwd: relativeDirectory },
      timeoutSeconds: 1_800, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      evidence: [relativePath(root, cargo)]
    });
  }

  for (const goModule of byBasename.get("go.mod") ?? []) {
    const relativeDirectory = relativePath(root, path.dirname(goModule));
    technology("go", relativePath(root, goModule));
    add("high", "Go module detected.", {
      id: `${slug(relativeDirectory)}_go_test`, title: `Go Test (${relativeDirectory})`,
      description: `Run all Go tests in ${relativeDirectory}.`,
      runner: { kind: "host", command: "go", args: ["test", "./..."], cwd: relativeDirectory },
      timeoutSeconds: 1_800, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      evidence: [relativePath(root, goModule)]
    });
  }

  for (const pom of byBasename.get("pom.xml") ?? []) {
    const relativeDirectory = relativePath(root, path.dirname(pom));
    technology("java-maven", relativePath(root, pom));
    const wrapper = process.platform === "win32" && fs.existsSync(path.join(path.dirname(pom), "mvnw.cmd")) ? ".\\mvnw.cmd" : fs.existsSync(path.join(path.dirname(pom), "mvnw")) ? "./mvnw" : "mvn";
    add("high", "Maven project detected.", {
      id: `${slug(relativeDirectory)}_maven_test`, title: `Maven Test (${relativeDirectory})`,
      description: `Run Maven tests in ${relativeDirectory}.`, runner: { kind: "host", command: wrapper, args: ["test"], cwd: relativeDirectory },
      timeoutSeconds: 1_800, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }, evidence: [relativePath(root, pom)]
    });
  }

  for (const gradle of [...(byBasename.get("build.gradle") ?? []), ...(byBasename.get("build.gradle.kts") ?? [])]) {
    const directory = path.dirname(gradle);
    const relativeDirectory = relativePath(root, directory);
    technology("java-gradle", relativePath(root, gradle));
    const wrapper = process.platform === "win32" && fs.existsSync(path.join(directory, "gradlew.bat")) ? ".\\gradlew.bat" : fs.existsSync(path.join(directory, "gradlew")) ? "./gradlew" : "gradle";
    add("high", "Gradle project detected.", {
      id: `${slug(relativeDirectory)}_gradle_test`, title: `Gradle Test (${relativeDirectory})`,
      description: `Run Gradle tests in ${relativeDirectory}.`, runner: { kind: "host", command: wrapper, args: ["test"], cwd: relativeDirectory },
      timeoutSeconds: 1_800, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }, evidence: [relativePath(root, gradle)]
    });
  }

  for (const solution of files.filter((filename) => path.extname(filename).toLowerCase() === ".sln")) {
    technology("dotnet", relativePath(root, solution));
    add("high", ".NET solution detected.", {
      id: `${slug(relativePath(root, solution))}_dotnet_test`, title: `Dotnet Test (${path.basename(solution)})`,
      description: `Run tests for ${relativePath(root, solution)}.`, runner: { kind: "host", command: "dotnet", args: ["test", relativePath(root, solution), "--no-restore"], cwd: "." },
      timeoutSeconds: 1_800, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }, evidence: [relativePath(root, solution)]
    });
  }

  const composeFiles = files.filter((filename) => /^(?:docker-)?compose(?:\.[A-Za-z0-9_-]+)?\.ya?ml$/i.test(path.basename(filename)) && path.dirname(filename) === root);
  if (composeFiles.length) {
    for (const file of composeFiles) technology("docker-compose", relativePath(root, file));
    const ordered = composeFiles.sort((left, right) => {
      const score = (filename: string) => /docker-compose\.yml$/i.test(filename) ? 0 : /dev|local/i.test(filename) ? 1 : 2;
      return score(left) - score(right) || left.localeCompare(right);
    });
    const selected = ordered.slice(0, Math.min(2, ordered.length)).map((filename) => relativePath(root, filename));
    const services = [...new Set(ordered.flatMap((filename) => composeServices(readText(filename))))].sort();
    const composeEvidence = selected;
    add("high", "Root Compose files provide a deterministic merged-configuration check.", {
      id: "compose_config", title: "Compose Config", description: "Validate the merged Compose configuration without creating or changing containers.",
      runner: { kind: "compose", files: selected, args: ["config", "--quiet"], cwd: "." }, timeoutSeconds: 120,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, evidence: composeEvidence
    });
    add("high", "Compose service status is observational.", {
      id: "compose_ps", title: "Compose Services", description: "Inspect all services in the configured Compose project.",
      runner: { kind: "compose", files: selected, args: ["ps", "--all"], cwd: "." }, timeoutSeconds: 120,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, evidence: composeEvidence
    });
    if (services.length) {
      add("high", "Bounded, non-following Compose logs are observational.", {
        id: "compose_logs", title: "Compose Logs", description: "Read bounded, non-following logs from one configured Compose service.",
        runner: { kind: "compose", files: selected, args: ["logs", "--no-color"], cwd: "." },
        inputs: [
          { name: "tail", description: "Maximum log lines.", type: "integer", default: 200, minimum: 1, maximum: 1_000, valueTemplate: "--tail={value}" },
          { name: "service", description: "Compose service to inspect.", type: "enum", values: services, required: true }
        ],
        timeoutSeconds: 120, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, evidence: composeEvidence
      });
    }
  }

  if (fs.existsSync(path.join(root, "openspec"))) {
    technology("openspec", "openspec/");
    add("high", "OpenSpec directory detected; CI or repository setup must provide the CLI.", {
      id: "openspec_validate", title: "OpenSpec Validate", description: "Run strict validation for all OpenSpec specifications and active changes.",
      runner: { kind: "host", command: "openspec", args: ["validate", "--all", "--strict"], cwd: "." }, timeoutSeconds: 600,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }, evidence: ["openspec/"]
    });
  }

  const hasRootUv = fs.existsSync(path.join(root, "uv.lock"));
  for (const script of files) {
    const relative = relativePath(root, script);
    const basename = path.basename(script, path.extname(script));
    const parentName = path.basename(path.dirname(script));
    const candidateName = validationName.test(basename) || (validationName.test(parentName) && /^(?:main|run|runner|scenario|scenarios)$/i.test(basename));
    if (!relative.startsWith("scripts/") || relative.includes("/tests/") || !candidateName) continue;
    const extension = path.extname(script).toLowerCase();
    let command: string | undefined;
    let args: string[] = [];
    if (extension === ".py") {
      command = hasRootUv ? "uv" : "python";
      args = hasRootUv ? ["run", "--frozen", "--no-sync", "python", relative] : [relative];
      technology("python-scripts", relative);
    } else if (extension === ".js" || extension === ".mjs" || extension === ".cjs") {
      command = "node";
      args = [relative];
      technology("node-scripts", relative);
    } else if (extension === ".sh") {
      command = "bash";
      args = [relative];
      technology("shell-scripts", relative);
    } else if (extension === ".ps1") {
      command = "pwsh";
      args = ["-NoProfile", "-File", relative];
      technology("powershell-scripts", relative);
    }
    if (!command) continue;
    add("medium", "Repository-owned validation-like script detected by filename; confirm its prerequisites and side effects before approval.", {
      id: `script_${slug(relative)}`, title: `Script: ${path.basename(script)}`, description: `Run the repository script ${relative}. Extra arguments are passed directly as argv entries without a shell.`,
      runner: { kind: "host", command, args, cwd: "." },
      inputs: [{ name: "arguments", description: "Optional script arguments. This capability must be explicitly approved because flags are script-defined.", type: "strings" }],
      timeoutSeconds: /benchmark/i.test(relative) ? 7_200 : 1_800,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }, evidence: [relative]
    });
  }

  const ciFiles = files.filter((filename) => /[\\/]\.github[\\/]workflows[\\/].+\.ya?ml$/i.test(filename));
  if (ciFiles.length) technology("ci-github-actions", relativePath(root, ciFiles[0]));
  const requirements = ciFiles.flatMap((filename) => githubWorkflowRequirements(root, filename));
  const questions: string[] = [];
  if (composeFiles.length) questions.push("May validation execute inside existing Compose services and access their development data, or must it use isolated ephemeral containers?");
  if ([...candidates.values()].some(({ recipe }) => recipe.inputs.some((input) => input.type === "strings"))) {
    questions.push("Which repository-owned scripts may accept reviewer-supplied arguments, and should changed or untracked scripts remain executable?");
  }
  if (technologies.size > 1) questions.push("Which detected project units are mandatory review gates, and which are conditional on the files changed?");

  return {
    schemaVersion: 2,
    projectRoot: root,
    generatedAt: new Date().toISOString(),
    technologies: [...technologies.entries()].map(([id, evidence]) => ({ id, evidence: [...evidence].sort() })).sort((left, right) => left.id.localeCompare(right.id)),
    requirements: requirements.sort((left, right) => left.id.localeCompare(right.id)),
    candidates: [...candidates.values()].sort((left, right) => left.recipe.id.localeCompare(right.recipe.id)),
    questions
  };
}
