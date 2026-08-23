#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const bootstrapRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageMetadata = JSON.parse(fs.readFileSync(path.join(bootstrapRoot, "package.json"), "utf8"));
const defaultTemplateRepository = "https://github.com/uzi0espil/Codex-Claude-Reviewer-Bridge.git";
const valueOptions = new Set(["project-root", "project-name", "destination", "template-repository", "template-ref"]);
const booleanOptions = new Set(["skip-playwright", "device-auth"]);

export function parseBootstrapArguments(values) {
  const args = [...values];
  const first = args[0];
  const command = !first || first.startsWith("-") ? "create" : String(args.shift());
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value.startsWith("--")) throw new Error(`Unexpected argument: ${value}`);
    const name = value.slice(2);
    if (booleanOptions.has(name)) {
      options[name] = true;
      continue;
    }
    if (!valueOptions.has(name)) throw new Error(`Unknown option: ${value}`);
    if (index + 1 >= args.length) throw new Error(`${value} requires a value.`);
    options[name] = args[index += 1];
  }
  return { command, options };
}

function requireOption(options, name) {
  if (!options[name]) throw new Error(`--${name} is required.`);
  return String(options[name]);
}

function canonical(value, mustExist = true) {
  const absolute = path.resolve(String(value));
  return mustExist ? fs.realpathSync(absolute) : absolute;
}

function canonicalForCreation(value) {
  const missing = [];
  let existing = path.resolve(String(value));
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    missing.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(fs.realpathSync(existing), ...missing);
}

function isSameOrDescendant(candidate, parent) {
  const relative = path.relative(canonical(parent), canonical(candidate, false));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function run(command, args = [], settings = {}) {
  const result = spawnSync(command, args, {
    cwd: settings.cwd,
    env: settings.env ?? process.env,
    stdio: settings.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: settings.capture ? "utf8" : undefined,
    windowsHide: settings.windowsHide ?? false
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !settings.allowFailure) {
    const detail = settings.capture ? String(result.stderr || result.stdout || "").trim() : "";
    throw new Error(detail ? `${command} ${args.join(" ")} failed: ${detail}` : `${command} exited with code ${result.status}.`);
  }
  return {
    status: result.status ?? 1,
    stdout: settings.capture ? String(result.stdout ?? "").trim() : "",
    stderr: settings.capture ? String(result.stderr ?? "").trim() : ""
  };
}

function reviewerBranchName(templateRef) {
  const suffix = String(templateRef).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `reviewer-${suffix || "release"}`;
}

export function checkoutTemplateRef(destination, templateRef) {
  if (String(templateRef).startsWith("-")) throw new Error("Template ref must not begin with '-'.");
  run("git", ["-C", destination, "fetch", "--tags", "origin"]);
  const verified = run("git", ["-C", destination, "rev-parse", "--verify", "--quiet", `${templateRef}^{commit}`], {
    capture: true,
    allowFailure: true
  });
  if (verified.status !== 0) throw new Error(`Template ref '${templateRef}' was not found in the cloned repository.`);
  const remoteHead = run("git", ["-C", destination, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], {
    capture: true,
    allowFailure: true
  });
  if (remoteHead.status !== 0 || !remoteHead.stdout) {
    throw new Error("The template repository does not advertise a default branch for future updates.");
  }
  const branch = reviewerBranchName(templateRef);
  run("git", ["-C", destination, "checkout", "-b", branch, templateRef]);
  run("git", ["-C", destination, "branch", "--set-upstream-to", remoteHead.stdout, branch]);
}

export function templateSelection(options, version = packageMetadata.version) {
  const customRepository = options["template-repository"] ? String(options["template-repository"]) : undefined;
  return {
    repository: customRepository ?? defaultTemplateRepository,
    templateRef: options["template-ref"] ? String(options["template-ref"]) : customRepository ? undefined : `v${version}`
  };
}

function usage() {
  console.log(`Usage: claude-codex-review-bridge create --project-root <path> [options]

Create an isolated Claude-Codex reviewer beside an application repository.

Options:
  --project-root <path>          Git repository to review (required)
  --project-name <name>          Display name for the application
  --destination <path>           Reviewer destination; defaults to <project>-reviewer
  --template-repository <url>    Trusted template repository or private fork
  --template-ref <ref>           Initial tag or commit; updates follow the default branch
  --skip-playwright              Do not install the optional browser reviewer
  --device-auth                  Use device authentication for Codex
  --help                         Show this help
  --version                      Show the package version`);
}

export function createReviewer(options) {
  const projectRoot = canonical(requireOption(options, "project-root"));
  if (!fs.existsSync(path.join(projectRoot, ".git"))) throw new Error(`Project root is not a Git repository: ${projectRoot}`);
  const projectName = String(options["project-name"] ?? path.basename(projectRoot));
  const destination = canonicalForCreation(options.destination ?? path.join(path.dirname(projectRoot), `${path.basename(projectRoot)}-reviewer`));
  if (isSameOrDescendant(destination, projectRoot)) {
    throw new Error(`The reviewer instance must live outside the target repository. Choose a sibling destination instead of '${destination}'.`);
  }
  if (fs.existsSync(destination) && (!fs.statSync(destination).isDirectory() || fs.readdirSync(destination).length)) {
    throw new Error(`Destination must be absent or empty: ${destination}`);
  }

  const { repository, templateRef } = templateSelection(options);
  console.log(`Creating isolated reviewer instance at ${destination}`);
  run("git", ["clone", "--", repository, destination]);
  if (templateRef) checkoutTemplateRef(destination, templateRef);

  const required = [
    "scripts/reviewer.mjs",
    "scripts/shell/reviewer.sh",
    "scripts/powershell/reviewer.ps1",
    "skills/bridge-init-policy/SKILL.md"
  ];
  const missing = required.filter((entry) => !fs.existsSync(path.join(destination, entry)));
  if (missing.length) throw new Error(`The cloned template is incompatible with the isolated-instance workflow and is missing: ${missing.join(", ")}.`);

  const targetCli = path.join(destination, "scripts", "reviewer.mjs");
  const setupArgs = [targetCli, "setup", "--project-root", projectRoot, "--project-name", projectName];
  if (options["skip-playwright"]) setupArgs.push("--skip-playwright");
  run(process.execPath, setupArgs, { cwd: destination });
  const loginArgs = [targetCli, "login"];
  if (options["device-auth"]) loginArgs.push("--device-auth");
  run(process.execPath, loginArgs, { cwd: destination });
  console.log("Starting the Codex-guided review policy workflow.");
  run(process.execPath, [targetCli, "policy"], { cwd: destination });
}

export function main(argv = process.argv.slice(2)) {
  if (argv.includes("--help") || argv[0] === "help") return usage();
  if (argv.includes("--version") || argv[0] === "version") return console.log(packageMetadata.version);
  const { command, options } = parseBootstrapArguments(argv);
  if (command !== "create") throw new Error(`Unknown command: ${command}. The npm bootstrapper supports only 'create'.`);
  return createReviewer(options);
}

const invokedDirectly = process.argv[1]
  && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
