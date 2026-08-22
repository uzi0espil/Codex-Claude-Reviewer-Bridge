#!/usr/bin/env node

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

export const reviewerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const runtimeDirectory = path.join(reviewerRoot, "runtime");
export const endpointPath = path.join(runtimeDirectory, "endpoint.json");
export const localConfigPath = path.join(reviewerRoot, "bridge.local.json");
export const localPolicyPath = path.join(reviewerRoot, "review-policy.local.md");
const startupLockPath = path.join(runtimeDirectory, "startup.lock");

const optionNames = new Set([
  "project-root", "project-name", "destination", "template-repository", "feature",
  "profile", "prompt", "session", "ref", "terminal"
]);
const booleanNames = new Set(["skip-playwright", "device-auth", "resume", "last"]);

export function parseArguments(values) {
  const options = {};
  const positionals = [];
  let passthrough = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--") {
      passthrough = values.slice(index + 1);
      break;
    }
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    const name = value.slice(2);
    if (booleanNames.has(name)) {
      options[name] = true;
      continue;
    }
    if (!optionNames.has(name)) throw new Error(`Unknown option: ${value}`);
    if (index + 1 >= values.length) throw new Error(`${value} requires a value.`);
    options[name] = values[index += 1];
  }
  return { options, positionals, passthrough };
}

export function validateCommandArguments(command, options, passthrough) {
  const allowed = {
    create: ["project-root", "project-name", "destination", "template-repository", "skip-playwright", "device-auth"],
    setup: ["project-root", "project-name", "skip-playwright"],
    login: ["device-auth"],
    policy: ["project-root"],
    "start-pair": ["feature", "profile", "project-root", "terminal"],
    "start-coder": ["feature", "project-root"],
    "start-reviewer": ["prompt", "feature", "profile", "resume", "last", "session", "project-root"],
    ensure: [], stop: [], update: ["ref"]
  };
  if (!Object.hasOwn(allowed, command)) throw new Error(`Unknown command: ${command}`);
  for (const name of Object.keys(options)) {
    if (!allowed[command].includes(name)) throw new Error(`--${name} is not valid for ${command}.`);
  }
  if (passthrough.length && !["policy", "start-pair", "start-coder", "start-reviewer"].includes(command)) {
    throw new Error(`${command} does not accept trailing tool arguments.`);
  }
}

function requireOption(options, name) {
  const value = options[name];
  if (!value) throw new Error(`--${name} is required.`);
  return String(value);
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

function samePath(left, right) {
  const a = canonical(left).replace(/[\\/]+$/, "");
  const b = canonical(right).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isSameOrDescendant(candidate, parent) {
  const child = canonical(candidate, false);
  const root = canonical(parent);
  const relative = path.relative(root, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function tomlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function shellQuote(value) {
  const text = String(value);
  return `'${text.replaceAll("'", `'\"'\"'`)}'`;
}

export function powershellQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function commandCandidates(command) {
  if (path.isAbsolute(command) || command.includes(path.sep)) return [command];
  const directories = String(process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const extensions = process.platform === "win32"
    ? String(process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")
    : [""];
  const hasExtension = Boolean(path.extname(command));
  return directories.flatMap((directory) => (hasExtension ? [path.join(directory, command)] : extensions.map((extension) => path.join(directory, command + extension))));
}

export function resolveCommand(command) {
  for (const candidate of commandCandidates(command)) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch { /* continue */ }
  }
  return undefined;
}

function externalInvocation(command, args, environment = process.env) {
  const executable = resolveCommand(command);
  if (!executable) throw new Error(`Required command '${command}' was not found on PATH.`);
  if (process.platform !== "win32" || !/\.(?:cmd|bat)$/i.test(executable)) {
    return { command: executable, args, env: environment };
  }
  const runner = path.join(reviewerRoot, "scripts", "powershell", "internal", "Run-External.ps1");
  return {
    command: resolveCommand("powershell.exe") ?? "powershell.exe",
    args: ["-NoProfile", "-File", runner],
    env: { ...environment, REVIEWER_EXTERNAL_COMMAND: executable, REVIEWER_EXTERNAL_ARGUMENTS: JSON.stringify(args) }
  };
}

function run(command, args = [], settings = {}) {
  const invocation = externalInvocation(command, args, settings.env ?? process.env);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: settings.cwd,
    env: invocation.env,
    stdio: settings.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: settings.capture ? "utf8" : undefined,
    windowsHide: settings.windowsHide ?? false
  });
  if (result.error) throw result.error;
  if (settings.capture) {
    if (result.status !== 0 && !settings.allowFailure) {
      throw new Error(`${command} ${args.join(" ")} failed: ${(result.stderr || result.stdout || "").trim()}`);
    }
    return { status: result.status ?? 1, stdout: String(result.stdout ?? "").trim(), stderr: String(result.stderr ?? "").trim() };
  }
  if (result.status !== 0 && !settings.allowFailure) throw new Error(`${command} exited with code ${result.status}.`);
  return { status: result.status ?? 1 };
}

function loadConfig() {
  if (!fs.existsSync(localConfigPath)) throw new Error(`Bridge configuration is missing. Run '${platformExample("setup")}' first.`);
  return readJson(localConfigPath);
}

function resolveProjectRoot(requested) {
  const config = loadConfig();
  const bound = canonical(config.projectRoot);
  if (requested && !samePath(bound, requested)) {
    throw new Error(`This reviewer instance is permanently bound to '${bound}', not '${canonical(requested)}'. Create a separate reviewer instance for the other repository.`);
  }
  return bound;
}

function assertGitRepository(projectRoot) {
  if (!fs.existsSync(path.join(projectRoot, ".git"))) throw new Error(`ProjectRoot is not a Git repository: ${projectRoot}`);
}

function platformExample(command) {
  if (process.platform !== "win32") return `./scripts/shell/reviewer.sh ${command}`;
  return `.\\scripts\\powershell\\reviewer.ps1 ${command}`;
}

async function endpointHealth(timeout = 2000) {
  try {
    const endpoint = readJson(endpointPath);
    const response = await fetch(`${endpoint.url}/health`, { signal: AbortSignal.timeout(timeout) });
    const result = await response.json();
    return response.ok && result.ok ? endpoint : undefined;
  } catch {
    return undefined;
  }
}

async function bridgeRequest(route, body = {}) {
  const endpoint = readJson(endpointPath);
  const response = await fetch(`${endpoint.url}${route}`, {
    method: "POST",
    headers: { authorization: `Bearer ${endpoint.token}`, "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `Bridge returned HTTP ${response.status}.`);
  return result;
}

export function acquireStartupLock(lockPath = startupLockPath, now = Date.now()) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  try {
    fs.mkdirSync(lockPath);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const age = now - fs.statSync(lockPath).mtimeMs;
    let ownerAlive = false;
    let ownerKnown = false;
    try {
      const owner = readJson(path.join(lockPath, "owner.json"));
      ownerKnown = Number.isInteger(owner.pid);
      if (ownerKnown) {
        process.kill(Number(owner.pid), 0);
        ownerAlive = true;
      }
    } catch (ownerError) {
      if (ownerError?.code === "EPERM") ownerAlive = true;
    }
    if (ownerAlive || (!ownerKnown && age < 60_000)) return false;
    fs.rmSync(lockPath, { recursive: true, force: true });
    try {
      fs.mkdirSync(lockPath);
    } catch (retryError) {
      if (retryError?.code === "EEXIST") return false;
      throw retryError;
    }
  }
  writeJson(path.join(lockPath, "owner.json"), { pid: process.pid, createdAt: new Date(now).toISOString() });
  return true;
}

async function ensureBridge() {
  const healthy = await endpointHealth();
  if (healthy) return healthy;
  const deadline = Date.now() + 30_000;
  let acquired = acquireStartupLock();
  while (!acquired && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    const endpoint = await endpointHealth(500);
    if (endpoint) return endpoint;
    acquired = acquireStartupLock();
  }
  if (!acquired) throw new Error("Timed out waiting for another bridge startup to finish.");
  try {
    const secondCheck = await endpointHealth();
    if (secondCheck) return secondCheck;
    const broker = path.join(reviewerRoot, "dist", "broker.js");
    if (!fs.existsSync(broker)) throw new Error(`Bridge has not been built. Run '${platformExample("setup")}' first.`);
    fs.rmSync(endpointPath, { force: true });
    const child = spawn(process.execPath, [broker], {
      cwd: reviewerRoot,
      detached: true,
      windowsHide: true,
      stdio: "ignore",
      env: process.env
    });
    child.unref();
    const startupDeadline = Date.now() + 20_000;
    while (Date.now() < startupDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      const endpoint = await endpointHealth(500);
      if (endpoint) return endpoint;
    }
    const logPath = path.join(runtimeDirectory, "bridge.log");
    const detail = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8").split(/\r?\n/).slice(-20).join("\n") : "No bridge log was produced.";
    throw new Error(`The review bridge did not start.\n${detail}`);
  } finally {
    fs.rmSync(startupLockPath, { recursive: true, force: true });
  }
}

function projectSettings(projectRoot, projectName, skipPlaywright, existingConfig) {
  const packageJson = readJson(path.join(reviewerRoot, "package.json"));
  return {
    instanceId: existingConfig?.instanceId ?? randomUUID(),
    projectName,
    projectRoot,
    templateVersion: packageJson.version,
    playwrightEnabled: !skipPlaywright,
    configuredAt: existingConfig?.configuredAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

export function claudeSettings(projectRoot, playwrightEnabled = true) {
  const hookScript = path.join(reviewerRoot, "dist", "claude-hook.js");
  const reviewerLeaf = path.basename(reviewerRoot);
  return {
    permissions: {
      deny: [
        `Read(${reviewerRoot}/**)`, `Edit(${reviewerRoot}/**)`, `Write(${reviewerRoot}/**)`,
        `Glob(${reviewerRoot}/**)`, `Grep(${reviewerRoot}/**)`, `Bash(*${reviewerLeaf}*)`,
        `PowerShell(*${reviewerLeaf}*)`
      ]
    },
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: "node", args: [hookScript, "session"], timeout: 30, statusMessage: "Restoring the paired review session" }] }],
      UserPromptSubmit: [{ hooks: [{ type: "command", command: "node", args: [hookScript, "prompt"], timeout: 30, statusMessage: "Pairing this workstream context with Codex" }] }],
      PreToolUse: [{ matcher: "AskUserQuestion", hooks: [{ type: "command", command: "node", args: [hookScript, "question"], timeout: 30, statusMessage: "Sending Claude's question to the paired Codex adviser" }] }],
      Stop: [{ hooks: [{ type: "command", command: "node", args: [hookScript, "stop"], timeout: 86400, statusMessage: "Waiting for the paired Codex review" }] }]
    }
  };
}

export function codexConfig(projectRoot, skipPlaywright) {
  const lines = [
    "# Generated by the reviewer CLI. Re-run setup after moving this folder.",
    'default_permissions = "bridge-review"', 'approval_policy = "on-request"', 'web_search = "live"',
    'project_doc_fallback_filenames = ["CLAUDE.md"]', "project_doc_max_bytes = 65536", "",
    "[features]", "apps = false", "hooks = false", "", "[mcp_servers.review_bridge]", "command = \"node\"",
    `args = [${tomlLiteral(path.join(reviewerRoot, "dist", "mcp-server.js"))}]`, "enabled = true",
    "startup_timeout_sec = 10", "tool_timeout_sec = 2592000"
  ];
  for (const tool of ["set_mode", "publish", "force_publish", "status", "cancel"]) {
    lines.push("", `[mcp_servers.review_bridge.tools.review_bridge_${tool}]`, 'approval_mode = "approve"');
  }
  lines.push("", "[mcp_servers.review_bridge.tools.review_bridge_write_policy]", 'approval_mode = "prompt"');
  if (!skipPlaywright) {
    const playwright = path.join(reviewerRoot, "node_modules", "@playwright", "mcp", "cli.js");
    if (!fs.existsSync(playwright)) throw new Error("Playwright MCP was not installed.");
    lines.push(
      "", "[mcp_servers.playwright]", 'command = "node"',
      `args = [${tomlLiteral(playwright)}, '--isolated', '--allow-unrestricted-file-access', '--output-dir', ${tomlLiteral(path.join(runtimeDirectory, "playwright"))}]`,
      `cwd = ${tomlLiteral(projectRoot)}`, "enabled = true", "startup_timeout_sec = 30", "tool_timeout_sec = 120"
    );
    for (const tool of ["browser_navigate", "browser_fill_form", "browser_click", "browser_resize", "browser_evaluate", "browser_run_code_unsafe", "browser_press_key"]) {
      lines.push("", `[mcp_servers.playwright.tools.${tool}]`, 'approval_mode = "approve"');
    }
  }
  lines.push(
    "", "[permissions.bridge-review]", 'description = "Independent review: read project files without editing them."', 'extends = ":read-only"',
    "", "[permissions.bridge-write]", 'description = "Explicit implementation work inside the active project workspace."', 'extends = ":workspace"'
  );
  return `${lines.join("\n")}\n`;
}

async function setup(options) {
  const projectRoot = canonical(requireOption(options, "project-root"));
  assertGitRepository(projectRoot);
  const projectName = String(options["project-name"] ?? path.basename(projectRoot));
  let existing;
  if (fs.existsSync(localConfigPath)) {
    existing = readJson(localConfigPath);
    if (!samePath(existing.projectRoot, projectRoot)) {
      throw new Error(`This reviewer instance is already bound to '${canonical(existing.projectRoot)}'. Create a new reviewer instance for '${projectRoot}'.`);
    }
  }
  for (const command of ["node", "npm", "codex", "claude"]) {
    if (!resolveCommand(command)) throw new Error(`Required command '${command}' was not found on PATH.`);
  }
  run("npm", ["install"], { cwd: reviewerRoot });
  run("npm", ["test"], { cwd: reviewerRoot });
  const config = projectSettings(projectRoot, projectName, Boolean(options["skip-playwright"]), existing);
  writeJson(localConfigPath, config);
  writeJson(path.join(reviewerRoot, "claude-bridge.settings.json"), claudeSettings(projectRoot, config.playwrightEnabled));
  fs.writeFileSync(path.join(reviewerRoot, "config.toml"), codexConfig(projectRoot, !config.playwrightEnabled), "utf8");
  console.log(`Review bridge installed for '${projectName}' at ${projectRoot}`);
  console.log(`Next: run '${platformExample("login")}', then '${platformExample("policy")}'.`);
}

async function login(options) {
  const environment = { ...process.env, CODEX_HOME: reviewerRoot };
  const status = run("codex", ["login", "status"], { env: environment, allowFailure: true });
  if (status.status === 0) {
    console.log(`Codex is already authenticated for ${reviewerRoot}`);
    return;
  }
  run("codex", options["device-auth"] ? ["login", "--device-auth"] : ["login"], { env: environment });
}

async function policy(options, passthrough) {
  const projectRoot = resolveProjectRoot(options["project-root"]);
  const prompt = "Use $bridge-init-policy to inspect this application and create or refresh its private review policy and protocol.";
  run("codex", ["-C", projectRoot, "--profile", "bridge-review", ...passthrough, prompt], {
    cwd: projectRoot, env: { ...process.env, CODEX_HOME: reviewerRoot }
  });
}

async function startCoder(options, passthrough) {
  await ensureBridge();
  const feature = requireOption(options, "feature");
  const projectRoot = resolveProjectRoot(options["project-root"]);
  const pair = await bridgeRequest("/pair/claude", { feature, projectRoot });
  const settings = path.join(reviewerRoot, "claude-bridge.settings.json");
  if (!fs.existsSync(settings)) throw new Error(`Claude hook settings are missing; run '${platformExample("setup")}'.`);
  const args = ["--name", pair.displayName, "--settings", settings];
  if (pair.claudeSessionId) args.push(pair.claudeSessionStarted ? "--resume" : "--session-id", pair.claudeSessionId);
  args.push(...passthrough);
  run("claude", args, { cwd: projectRoot, env: { ...process.env, REVIEW_BRIDGE_FEATURE: pair.feature } });
}

async function startReviewer(options, passthrough) {
  const projectRoot = resolveProjectRoot(options["project-root"]);
  assertGitRepository(projectRoot);
  const selectors = [options.resume, options.last, options.session].filter(Boolean);
  if (options.profile && !["off", "manual", "once", "auto"].includes(String(options.profile))) throw new Error("--profile must be off, manual, once, or auto.");
  if (selectors.length > 1) throw new Error("Use only one of --resume, --last, or --session.");
  if (options.resume && options.prompt) throw new Error("The session picker cannot accept an initial prompt.");
  if (options.feature && (options.resume || options.last || options.session || options.prompt)) {
    throw new Error("Paired mode uses the stored feature mapping; do not combine --feature with another session selector or prompt.");
  }
  const args = [];
  if (options.feature) {
    await ensureBridge();
    let pair = await bridgeRequest("/pair/codex", { feature: options.feature, projectRoot });
    const profile = options.profile ?? pair.mode;
    if (options.profile) pair = await bridgeRequest("/mode", { feature: pair.feature, mode: options.profile });
    args.push("--remote", pair.appServerUrl, "resume", pair.codexThreadId, "-C", projectRoot, "--profile", `bridge-${profile}`);
  } else if (options.session) args.push("resume", String(options.session), "-C", projectRoot);
  else if (options.last) args.push("resume", "--last", "-C", projectRoot);
  else if (options.resume) args.push("resume", "-C", projectRoot);
  else args.push("-C", projectRoot);
  args.push(...passthrough);
  if (options.prompt) args.push(String(options.prompt));
  run("codex", args, { cwd: projectRoot, env: { ...process.env, CODEX_HOME: reviewerRoot } });
}

function pairChildArguments(kind, options, passthrough) {
  const values = [kind, "--feature", String(options.feature)];
  if (options["project-root"]) values.push("--project-root", String(options["project-root"]));
  if (kind === "start-reviewer" && options.profile) values.push("--profile", String(options.profile));
  if (kind === "start-coder" && passthrough.length) values.push("--", ...passthrough);
  return values;
}

export function terminalLaunchSpec(platform, terminal, reviewerScript, childArgs) {
  const command = [shellQuote(reviewerScript), ...childArgs.map(shellQuote)].join(" ");
  if (platform === "darwin") {
    const escaped = command.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\r", "\\r").replaceAll("\n", "\\n");
    return { command: "osascript", args: ["-e", `tell application \"Terminal\" to do script \"${escaped}\"`] };
  }
  const shellCommand = `${command}; exec bash`;
  if (terminal === "gnome-terminal") return { command: terminal, args: ["--", "bash", "-lc", shellCommand] };
  if (terminal === "konsole") return { command: terminal, args: ["-e", "bash", "-lc", shellCommand] };
  if (terminal === "xfce4-terminal") return { command: terminal, args: ["--command", `bash -lc ${shellQuote(shellCommand)}`] };
  return { command: terminal, args: ["-e", "bash", "-lc", shellCommand] };
}

export function windowsTerminalLaunchSpec(terminal, launcher, childArgs, cwd, title) {
  const encoded = Buffer.from(JSON.stringify(childArgs), "utf8").toString("base64");
  return {
    command: terminal,
    args: [
      "-w", "new", "new-tab", "--title", title, "--startingDirectory", cwd,
      "powershell.exe", "-NoProfile", "-NoExit", "-File", launcher, "-EncodedArguments", encoded
    ]
  };
}

function launchDetached(spec, cwd) {
  return new Promise((resolve, reject) => {
    const executable = resolveCommand(spec.command) ?? spec.command;
    const child = spawn(executable, spec.args, { cwd, detached: true, stdio: "ignore", windowsHide: false });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

async function startPair(options, passthrough) {
  const feature = requireOption(options, "feature");
  if (options.profile && !["off", "manual", "once", "auto"].includes(String(options.profile))) throw new Error("--profile must be off, manual, once, or auto.");
  if (options.terminal && !["auto", "print"].includes(String(options.terminal))) throw new Error("--terminal must be auto or print.");
  const projectRoot = resolveProjectRoot(options["project-root"]);
  if (!fs.existsSync(localPolicyPath)) console.warn(`Warning: no application-specific review policy exists. Run '${platformExample("policy")}' to create one.`);
  const common = { ...options, feature, "project-root": projectRoot };
  const coderArgs = pairChildArguments("start-coder", common, passthrough);
  const reviewerArgs = pairChildArguments("start-reviewer", common, []);
  if (options.terminal === "print") return printPairCommands(coderArgs, reviewerArgs);
  if (process.platform === "win32") {
    const launcher = path.join(reviewerRoot, "scripts", "powershell", "internal", "Launch-Reviewer.ps1");
    const terminalLauncher = path.join(reviewerRoot, "scripts", "powershell", "internal", "Open-ReviewerTerminal.ps1");
    for (const spec of [
      windowsTerminalLaunchSpec("wt.exe", launcher, coderArgs, projectRoot, `Claude · ${feature}`),
      windowsTerminalLaunchSpec("wt.exe", launcher, reviewerArgs, projectRoot, `Codex · ${feature}`)
    ]) {
      const encoded = Buffer.from(JSON.stringify(spec.args), "utf8").toString("base64");
      run("powershell.exe", ["-NoProfile", "-File", terminalLauncher, "-EncodedArguments", encoded], {
        cwd: projectRoot, capture: true, windowsHide: true
      });
    }
  } else {
    const wrapper = path.join(reviewerRoot, "scripts", "shell", "reviewer.sh");
    if (process.platform === "darwin") {
      await launchDetached(terminalLaunchSpec("darwin", "Terminal", wrapper, coderArgs), projectRoot);
      await launchDetached(terminalLaunchSpec("darwin", "Terminal", wrapper, reviewerArgs), projectRoot);
    } else {
      const graphicalSession = process.env.DISPLAY || process.env.WAYLAND_DISPLAY;
      const terminal = graphicalSession && ["gnome-terminal", "konsole", "xfce4-terminal", "x-terminal-emulator", "xterm"].find(resolveCommand);
      if (!terminal) return printPairCommands(coderArgs, reviewerArgs);
      await launchDetached(terminalLaunchSpec("linux", terminal, wrapper, coderArgs), projectRoot);
      await launchDetached(terminalLaunchSpec("linux", terminal, wrapper, reviewerArgs), projectRoot);
    }
  }
  console.log(`Opened paired Claude and Codex terminals for '${feature}'.`);
}

function printPairCommands(coderArgs, reviewerArgs) {
  const wrapper = path.join(reviewerRoot, "scripts", "shell", "reviewer.sh");
  const quote = process.platform === "win32" ? powershellQuote : shellQuote;
  const prefix = process.platform === "win32"
    ? `& ${quote(process.execPath)} ${quote(path.join(reviewerRoot, "scripts", "reviewer.mjs"))}`
    : quote(wrapper);
  console.log("No supported terminal launcher was selected. Run these commands in separate terminals:");
  console.log(`${prefix} ${coderArgs.map(quote).join(" ")}`);
  console.log(`${prefix} ${reviewerArgs.map(quote).join(" ")}`);
}

async function stop(quiet = false) {
  const endpoint = await endpointHealth();
  if (!endpoint) {
    if (!quiet) console.log("The review bridge is not running.");
    return;
  }
  try {
    await bridgeRequest("/shutdown");
  } catch (error) {
    const stillOwned = await endpointHealth();
    if (!stillOwned || stillOwned.url !== endpoint.url || stillOwned.pid !== endpoint.pid) throw error;
    // Compatibility for brokers older than 0.3.0, which predate /shutdown.
    process.kill(Number(endpoint.pid), "SIGTERM");
  }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && await endpointHealth(250)) await new Promise((resolve) => setTimeout(resolve, 100));
  if (await endpointHealth(250)) throw new Error("The review bridge did not stop within five seconds.");
  if (!quiet) console.log(`Stopped review bridge process ${endpoint.pid}.`);
}

async function update(options) {
  const config = loadConfig();
  const projectRoot = resolveProjectRoot();
  const dirty = run("git", ["-C", reviewerRoot, "status", "--porcelain", "--untracked-files=no"], { capture: true }).stdout;
  if (dirty) throw new Error("Tracked reviewer files have local changes. Commit or resolve them before updating; the updater will not overwrite them.");
  const beforeCommit = run("git", ["-C", reviewerRoot, "rev-parse", "HEAD"], { capture: true }).stdout;
  const beforePackage = readJson(path.join(reviewerRoot, "package.json"));
  run("git", ["-C", reviewerRoot, "fetch", "--prune", "origin"]);
  let target = options.ref;
  if (!target) {
    const upstream = run("git", ["-C", reviewerRoot, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], { capture: true, allowFailure: true });
    if (upstream.status !== 0 || !upstream.stdout) throw new Error("The current branch has no upstream. Pass --ref explicitly.");
    target = upstream.stdout;
  }
  await stop(true);
  run("git", ["-C", reviewerRoot, "merge", "--ff-only", String(target)]);
  const setupArgs = [path.join(reviewerRoot, "scripts", "reviewer.mjs"), "setup", "--project-root", projectRoot, "--project-name", config.projectName];
  if (config.playwrightEnabled === false) setupArgs.push("--skip-playwright");
  run(process.execPath, setupArgs, { cwd: reviewerRoot });
  const afterCommit = run("git", ["-C", reviewerRoot, "rev-parse", "HEAD"], { capture: true }).stdout;
  const afterPackage = readJson(path.join(reviewerRoot, "package.json"));
  console.log(`Reviewer instance updated: ${beforeCommit} -> ${afterCommit}`);
  console.log(`Bridge package version: ${beforePackage.version} -> ${afterPackage.version}`);
}

async function create(options) {
  if (!resolveCommand("git")) throw new Error("Required command 'git' was not found on PATH.");
  const projectRoot = canonical(requireOption(options, "project-root"));
  assertGitRepository(projectRoot);
  const projectName = String(options["project-name"] ?? path.basename(projectRoot));
  const destination = canonicalForCreation(options.destination ?? path.join(path.dirname(projectRoot), `${path.basename(projectRoot)}-reviewer`));
  if (isSameOrDescendant(destination, projectRoot)) throw new Error(`The reviewer instance must live outside the target repository. Choose a sibling destination instead of '${destination}'.`);
  if (fs.existsSync(destination) && (!fs.statSync(destination).isDirectory() || fs.readdirSync(destination).length)) {
    throw new Error(`Destination must be absent or empty: ${destination}`);
  }
  let repository = options["template-repository"];
  if (!repository) {
    const changes = run("git", ["-C", reviewerRoot, "status", "--porcelain"], { capture: true }).stdout;
    if (changes) throw new Error("The factory checkout has uncommitted or untracked changes. Commit and push the template before generating an instance.");
    const remote = run("git", ["-C", reviewerRoot, "remote", "get-url", "origin"], { capture: true, allowFailure: true });
    repository = remote.status === 0 && remote.stdout ? remote.stdout : "https://github.com/uzi0espil/Codex-Claude-Reviewer-Bridge.git";
    run("git", ["-C", reviewerRoot, "fetch", "--prune", "origin"]);
    const upstream = run("git", ["-C", reviewerRoot, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], { capture: true, allowFailure: true });
    if (upstream.status !== 0 || !upstream.stdout) throw new Error("The factory branch has no upstream. Push it or pass --template-repository explicitly.");
    const head = run("git", ["-C", reviewerRoot, "rev-parse", "HEAD"], { capture: true }).stdout;
    const published = run("git", ["-C", reviewerRoot, "rev-parse", upstream.stdout], { capture: true }).stdout;
    if (head !== published) throw new Error(`The factory checkout is not synchronized with '${upstream.stdout}'. Push or update it before generating an instance.`);
  }
  console.log(`Creating isolated reviewer instance at ${destination}`);
  run("git", ["clone", "--", String(repository), destination]);
  const required = ["scripts/reviewer.mjs", "scripts/shell/reviewer.sh", "scripts/powershell/reviewer.ps1", "skills/bridge-init-policy/SKILL.md"];
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

function usage() {
  console.log(`Usage: reviewer <command> [options] [-- tool arguments]\n\nCommands:\n  create          Clone and initialize an isolated reviewer\n  setup           Install, test, and bind this reviewer\n  login           Authenticate its isolated Codex home\n  policy          Create or refresh the private review policy\n  start-pair      Open paired Claude and Codex terminals\n  start-coder     Run the paired Claude session\n  start-reviewer  Run the paired or standalone Codex session\n  ensure          Ensure the background bridge is running\n  stop            Gracefully stop the background bridge\n  update          Fast-forward and reconfigure this reviewer`);
}

export async function main(argv = process.argv.slice(2)) {
  const command = argv[0];
  if (!command || command === "help" || command === "--help") return usage();
  const { options, positionals, passthrough } = parseArguments(argv.slice(1));
  if (positionals.length) throw new Error(`Unexpected argument: ${positionals[0]}`);
  validateCommandArguments(command, options, passthrough);
  if (command === "create") return create(options);
  if (command === "setup") return setup(options);
  if (command === "login") return login(options);
  if (command === "policy") return policy(options, passthrough);
  if (command === "start-pair") return startPair(options, passthrough);
  if (command === "start-coder") return startCoder(options, passthrough);
  if (command === "start-reviewer") return startReviewer(options, passthrough);
  if (command === "ensure") return void await ensureBridge();
  if (command === "stop") return stop();
  if (command === "update") return update(options);
  throw new Error(`Unknown command: ${command}`);
}

const invokedDirectly = process.argv[1] && canonical(process.argv[1]) === canonical(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
