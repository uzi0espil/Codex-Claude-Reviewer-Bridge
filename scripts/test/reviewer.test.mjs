import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  acquireStartupLock,
  claudeSettings,
  codexConfig,
  parseArguments,
  pairedCodexArguments,
  policyCodexArguments,
  powershellQuote,
  readSessionReport,
  shellQuote,
  terminalLaunchSpec,
  tomlLiteral,
  validateCommandArguments,
  windowsTerminalLaunchSpec
} from "../reviewer.mjs";

test("parses CLI options and preserves tool arguments", () => {
  assert.deepEqual(
    parseArguments(["--feature", "quoted feature", "--resume", "--", "--model", "gpt-5", "a'b"]),
    {
      options: { feature: "quoted feature", resume: true },
      positionals: [],
      passthrough: ["--model", "gpt-5", "a'b"]
    }
  );
});

test("rejects unknown CLI options", () => {
  assert.throws(() => parseArguments(["--unknown"]), /Unknown option/);
  assert.throws(() => validateCommandArguments("stop", { feature: "x" }, []), /not valid for stop/);
  assert.throws(() => validateCommandArguments("setup", {}, ["--model", "x"]), /does not accept/);
  assert.doesNotThrow(() => validateCommandArguments("tools", { "project-root": "/tmp/app" }, ["--model", "x"]));
  assert.doesNotThrow(() => validateCommandArguments("report", { feature: "x", full: true }, []));
});

test("reads the live session report from the broker with optional full content", async () => {
  const calls = [];
  const request = async (route, body) => {
    calls.push({ route, body });
    return { report: "# Live report\n" };
  };
  assert.equal(await readSessionReport("Feature One", true, request), "# Live report\n");
  assert.deepEqual(calls, [{ route: "/report", body: { feature: "Feature One", full: true } }]);
  await assert.rejects(
    readSessionReport("Feature One", false, async () => ({ report: 42 })),
    /invalid session report/i
  );
  assert.deepEqual(parseArguments(["--feature", "feature", "--full"]), {
    options: { feature: "feature", full: true },
    positionals: [],
    passthrough: []
  });
});

test("quotes Bash, PowerShell, and TOML literals without interpolation", () => {
  assert.equal(shellQuote("a'b"), `'a'\"'\"'b'`);
  assert.equal(powershellQuote("a'b"), "'a''b'");
  assert.equal(tomlLiteral("a'b"), "'a''b'");
});

test("builds terminal launches without flattening the terminal argument vector", () => {
  assert.deepEqual(
    terminalLaunchSpec("linux", "gnome-terminal", "/tmp/reviewer app/reviewer.sh", ["start-coder", "--feature", "a'b"]),
    {
      command: "gnome-terminal",
      args: ["--", "bash", "-lc", "'/tmp/reviewer app/reviewer.sh' 'start-coder' '--feature' 'a'\"'\"'b'; exec bash"]
    }
  );
});

test("builds visible Windows Terminal launches with encoded child arguments", () => {
  const childArgs = ["start-coder", "--feature", "a feature", "--", "--agent", "project-manager"];
  const spec = windowsTerminalLaunchSpec(
    "C:\\Users\\user\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe",
    "E:\\reviewer home\\scripts\\powershell\\internal\\Launch-Reviewer.ps1",
    childArgs,
    "E:\\project root",
    "Claude · a feature"
  );
  assert.equal(spec.command, "C:\\Users\\user\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe");
  assert.deepEqual(spec.args.slice(0, 7), [
    "-w", "new", "new-tab", "--title", "Claude · a feature", "--startingDirectory", "E:\\project root"
  ]);
  assert.deepEqual(spec.args.slice(7, 13), [
    "powershell.exe", "-NoProfile", "-NoExit", "-File",
    "E:\\reviewer home\\scripts\\powershell\\internal\\Launch-Reviewer.ps1", "-EncodedArguments"
  ]);
  assert.deepEqual(JSON.parse(Buffer.from(spec.args[13], "base64").toString("utf8")), childArgs);
});

test("paired Codex sessions resume remotely without permission overrides", () => {
  const args = pairedCodexArguments(
    { appServerUrl: "ws://127.0.0.1:1234", codexThreadId: "thread-1" },
    "C:\\project",
    ["--model", "gpt-test"]
  );
  assert.deepEqual(args, [
    "--remote", "ws://127.0.0.1:1234",
    "--no-alt-screen",
    "resume", "thread-1",
    "-C", "C:\\project",
    "--model", "gpt-test"
  ]);
  assert.equal(args.includes("--profile"), false);
  assert.equal(pairedCodexArguments(
    { appServerUrl: "ws://127.0.0.1:1234", codexThreadId: "thread-1" },
    "C:\\project",
    ["--no-alt-screen"]
  ).filter((value) => value === "--no-alt-screen").length, 1);
});

test("policy initialization cannot access review-tool curation", () => {
  const args = policyCodexArguments("C:\\project", [
    "--model", "gpt-test",
    "-c", "mcp_servers.review_tools.enabled=true"
  ]);
  assert.deepEqual(args.slice(0, 6), [
    "-C", "C:\\project", "--profile", "bridge-review", "--model", "gpt-test"
  ]);
  assert.deepEqual(args.slice(-3, -1), [
    "-c", "mcp_servers.review_tools.enabled=false"
  ]);
  assert.match(args.at(-1), /\$bridge-init-policy/);

  const skill = fs.readFileSync(
    fileURLToPath(new URL("../../skills/bridge-init-policy/SKILL.md", import.meta.url)),
    "utf8"
  );
  assert.match(skill, /never refresh tool detection/);
  assert.match(skill, /do not switch to\s+`\$bridge-init-tools`/);
  assert.match(skill, /Report point-in-time manifest coverage only in the surrounding session response/);
  assert.match(skill, /Never copy the current tool inventory/);
  assert.match(skill, /not in the proposed\s+policy text/);
  assert.match(skill, /exact bytes using strict\s+UTF-8 decoding/);
  assert.match(skill, /Before claiming that stored text is\s+corrupted/);
  assert.match(skill, /Do not normalize them to ASCII/);
  assert.match(skill, /If they are identical, or the proposed diff is\s+otherwise empty/);
  assert.match(skill, /Do not ask for approval, call the policy writer, or\s+re-save an unchanged file/);
  assert.match(skill, /explicit approval only when the proposed file content changes/);
});

test("generates portable Claude hooks and Codex configuration", () => {
  const settings = claudeSettings("/tmp/project");
  assert.equal(settings.hooks.PreToolUse[0].matcher, "AskUserQuestion");
  assert.equal(settings.hooks.Stop[0].hooks[0].command, "node");
  const config = codexConfig("/tmp/project with spaces", true);
  assert.match(config, /web_search = "live"/);
  assert.match(config, /\[windows\]\nsandbox = "unelevated"/);
  assert.match(config, /\[permissions\.bridge-review\]/);
  assert.match(config, /review_bridge_record_auto_decision/);
  assert.match(config, /review_bridge_defer_checkpoint/);
  assert.match(config, /\[mcp_servers\.review_tools\]/);
  assert.match(config, /review_tools_write_manifest\]\napproval_mode = "prompt"/);
  assert.doesNotMatch(config, /mcp_servers\.playwright/);
});

test("startup locking serializes callers and recovers stale owners", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-lock-"));
  try {
    const lock = path.join(temporary, "runtime", "startup.lock");
    const now = Date.now();
    assert.equal(acquireStartupLock(lock, now), true);
    assert.equal(acquireStartupLock(lock, now + 1_000), false);
    fs.writeFileSync(path.join(lock, "owner.json"), '{"pid":2147483647}\n');
    assert.equal(acquireStartupLock(lock, now), true);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("setup bootstraps an isolated reviewer and preserves immutable project binding", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-cli-"));
  try {
    const instance = path.join(temporary, "reviewer instance");
    const scripts = path.join(instance, "scripts");
    const commands = path.join(temporary, "commands");
    const firstProject = path.join(temporary, "first project");
    const secondProject = path.join(temporary, "second project");
    for (const directory of [scripts, commands, path.join(instance, "dist"), path.join(firstProject, ".git"), path.join(secondProject, ".git")]) {
      fs.mkdirSync(directory, { recursive: true });
    }
    fs.copyFileSync(fileURLToPath(new URL("../reviewer.mjs", import.meta.url)), path.join(scripts, "reviewer.mjs"));
    fs.mkdirSync(path.join(scripts, "powershell"), { recursive: true });
    fs.mkdirSync(path.join(scripts, "powershell", "internal"), { recursive: true });
    fs.copyFileSync(fileURLToPath(new URL("../powershell/internal/Run-External.ps1", import.meta.url)), path.join(scripts, "powershell", "internal", "Run-External.ps1"));
    fs.writeFileSync(path.join(instance, "package.json"), '{"version":"test-version"}\n');
    fs.writeFileSync(path.join(instance, "dist", "review-tools-discover.js"), "const fs=require('node:fs');const path=require('node:path');const root=JSON.parse(fs.readFileSync(path.join(__dirname,'..','bridge.local.json'),'utf8')).projectRoot;fs.writeFileSync(path.join(__dirname,'..','review-tools.detected.json'),JSON.stringify({schemaVersion:2,projectRoot:root,generatedAt:new Date().toISOString(),technologies:[],requirements:[],candidates:[],questions:[]})+'\\n');\n");

    const mockNames = ["npm", "codex", "claude"];
    if (process.platform === "win32") {
      for (const name of mockNames) fs.writeFileSync(path.join(commands, `${name}.cmd`), "@exit /b 0\r\n");
    } else {
      for (const name of mockNames) {
        const mock = path.join(commands, name);
        fs.writeFileSync(mock, "#!/bin/sh\nexit 0\n");
        fs.chmodSync(mock, 0o755);
      }
    }
    const environment = { ...process.env, PATH: `${commands}${path.delimiter}${process.env.PATH ?? ""}` };
    const cli = path.join(scripts, "reviewer.mjs");
    const setup = spawnSync(process.execPath, [cli, "setup", "--project-root", firstProject, "--project-name", "Fixture", "--skip-playwright"], {
      cwd: instance, env: environment, encoding: "utf8"
    });
    assert.equal(setup.status, 0, setup.stderr || setup.stdout);
    const local = JSON.parse(fs.readFileSync(path.join(instance, "bridge.local.json"), "utf8"));
    assert.equal(local.projectName, "Fixture");
    assert.equal(local.templateVersion, "test-version");
    assert.equal(local.playwrightEnabled, false);
    assert.equal(local.defaultMode, "manual");
    assert.equal(local.desktopNotifications, true);

    const setDefault = spawnSync(process.execPath, [cli, "default-mode", "auto"], {
      cwd: instance, env: environment, encoding: "utf8"
    });
    assert.equal(setDefault.status, 0, setDefault.stderr || setDefault.stdout);
    assert.match(setDefault.stdout, /new workstreams.*auto.*unlimited.*existing workstreams are unchanged/i);
    assert.equal(JSON.parse(fs.readFileSync(path.join(instance, "bridge.local.json"), "utf8")).defaultMode, "auto");

    const disableNotifications = spawnSync(process.execPath, [cli, "notifications", "off"], {
      cwd: instance, env: environment, encoding: "utf8"
    });
    assert.equal(disableNotifications.status, 0, disableNotifications.stderr || disableNotifications.stdout);
    assert.match(disableNotifications.stdout, /desktop notifications.*disabled/i);
    assert.equal(JSON.parse(fs.readFileSync(path.join(instance, "bridge.local.json"), "utf8")).desktopNotifications, false);

    const invalidNotifications = spawnSync(process.execPath, [cli, "notifications", "sometimes"], {
      cwd: instance, env: environment, encoding: "utf8"
    });
    assert.notEqual(invalidNotifications.status, 0);
    assert.match(invalidNotifications.stderr, /notifications <on\|off>/i);
    assert.equal(JSON.parse(fs.readFileSync(path.join(instance, "bridge.local.json"), "utf8")).desktopNotifications, false);

    const invalidDefault = spawnSync(process.execPath, [cli, "default-mode", "once"], {
      cwd: instance, env: environment, encoding: "utf8"
    });
    assert.notEqual(invalidDefault.status, 0);
    assert.match(invalidDefault.stderr, /must be off, manual, or auto/i);
    assert.equal(JSON.parse(fs.readFileSync(path.join(instance, "bridge.local.json"), "utf8")).defaultMode, "auto");
    assert.equal(JSON.parse(fs.readFileSync(path.join(instance, "claude-bridge.settings.json"), "utf8")).hooks.Stop[0].hooks[0].command, "node");
    const generatedConfig = fs.readFileSync(path.join(instance, "config.toml"), "utf8");
    assert.match(generatedConfig, /\[permissions\.bridge-write\]/);
    assert.match(generatedConfig, /review_bridge_record_auto_decision/);
    assert.match(generatedConfig, /review_bridge_defer_checkpoint/);
    assert.match(generatedConfig, /\[mcp_servers\.review_tools\]/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(instance, "review-tools.detected.json"), "utf8")).projectRoot, fs.realpathSync(firstProject));

    const rebound = spawnSync(process.execPath, [cli, "setup", "--project-root", secondProject, "--skip-playwright"], {
      cwd: instance, env: environment, encoding: "utf8"
    });
    assert.notEqual(rebound.status, 0);
    assert.match(rebound.stderr, /already bound/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("update fast-forwards an instance and reruns the updated setup", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-update-"));
  const git = (args, cwd) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout.trim();
  };
  try {
    const origin = path.join(temporary, "origin.git");
    const seed = path.join(temporary, "seed");
    const instance = path.join(temporary, "reviewer");
    const project = path.join(temporary, "application");
    const commands = path.join(temporary, "commands");
    fs.mkdirSync(seed, { recursive: true });
    fs.mkdirSync(path.join(project, ".git"), { recursive: true });
    fs.mkdirSync(commands, { recursive: true });
    git(["init", "--bare", origin], temporary);
    git(["init", "-b", "main"], seed);
    git(["config", "user.email", "tests@example.invalid"], seed);
    git(["config", "user.name", "Reviewer Tests"], seed);
    fs.mkdirSync(path.join(seed, "scripts"), { recursive: true });
    fs.copyFileSync(fileURLToPath(new URL("../reviewer.mjs", import.meta.url)), path.join(seed, "scripts", "reviewer.mjs"));
    fs.mkdirSync(path.join(seed, "scripts", "powershell", "internal"), { recursive: true });
    fs.copyFileSync(fileURLToPath(new URL("../powershell/internal/Run-External.ps1", import.meta.url)), path.join(seed, "scripts", "powershell", "internal", "Run-External.ps1"));
    fs.writeFileSync(path.join(seed, ".gitignore"), "/bridge.local.json\n/claude-bridge.settings.json\n/config.toml\n/runtime/\n");
    fs.writeFileSync(path.join(seed, "package.json"), '{"version":"0.2.1"}\n');
    git(["add", ".gitignore", "package.json", "scripts/reviewer.mjs", "scripts/powershell/internal/Run-External.ps1"], seed);
    git(["commit", "-m", "version 0.2.1"], seed);
    git(["remote", "add", "origin", origin], seed);
    git(["push", "-u", "origin", "main"], seed);
    git(["symbolic-ref", "HEAD", "refs/heads/main"], origin);
    git(["clone", origin, instance], temporary);
    fs.mkdirSync(path.join(instance, "dist"), { recursive: true });
    fs.writeFileSync(path.join(instance, "dist", "review-tools-discover.js"), "const fs=require('node:fs');const path=require('node:path');const root=JSON.parse(fs.readFileSync(path.join(__dirname,'..','bridge.local.json'),'utf8')).projectRoot;fs.writeFileSync(path.join(__dirname,'..','review-tools.detected.json'),JSON.stringify({schemaVersion:2,projectRoot:root,generatedAt:new Date().toISOString(),technologies:[],requirements:[],candidates:[],questions:[]})+'\\n');\n");

    fs.writeFileSync(path.join(seed, "package.json"), '{"version":"0.3.0"}\n');
    git(["add", "package.json"], seed);
    git(["commit", "-m", "version 0.3.0"], seed);
    git(["push"], seed);

    fs.writeFileSync(path.join(instance, "bridge.local.json"), `${JSON.stringify({
      instanceId: "fixture", projectName: "Fixture", projectRoot: project,
      defaultMode: "auto", templateVersion: "0.2.1", playwrightEnabled: false,
      desktopNotifications: false,
      configuredAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString()
    }, null, 2)}\n`);
    const mockNames = ["npm", "codex", "claude"];
    if (process.platform === "win32") {
      for (const name of mockNames) fs.writeFileSync(path.join(commands, `${name}.cmd`), "@exit /b 0\r\n");
    } else {
      for (const name of mockNames) {
        const mock = path.join(commands, name);
        fs.writeFileSync(mock, "#!/bin/sh\nexit 0\n");
        fs.chmodSync(mock, 0o755);
      }
    }
    const environment = { ...process.env, PATH: `${commands}${path.delimiter}${process.env.PATH ?? ""}` };
    const cli = path.join(instance, "scripts", "reviewer.mjs");
    const updated = spawnSync(process.execPath, [cli, "update"], { cwd: instance, env: environment, encoding: "utf8" });
    assert.equal(updated.status, 0, updated.stderr || updated.stdout);
    assert.match(updated.stdout, /Bridge package version: 0\.2\.1 -> 0\.3\.0/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(instance, "package.json"), "utf8")).version, "0.3.0");
    assert.equal(JSON.parse(fs.readFileSync(path.join(instance, "bridge.local.json"), "utf8")).templateVersion, "0.3.0");
    assert.equal(JSON.parse(fs.readFileSync(path.join(instance, "bridge.local.json"), "utf8")).defaultMode, "auto");
    assert.equal(JSON.parse(fs.readFileSync(path.join(instance, "bridge.local.json"), "utf8")).desktopNotifications, false);

    fs.writeFileSync(path.join(instance, "package.json"), '{"version":"locally-modified"}\n');
    const dirty = spawnSync(process.execPath, [cli, "update"], { cwd: instance, env: environment, encoding: "utf8" });
    assert.notEqual(dirty.status, 0);
    assert.match(dirty.stderr, /Tracked reviewer files have local changes/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
