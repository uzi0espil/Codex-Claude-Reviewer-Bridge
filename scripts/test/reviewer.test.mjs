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
  readLatestAutoReport,
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
});

test("reads the latest automatic report outside model history and rejects escaped paths", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-report-"));
  try {
    const reportDirectory = path.join(temporary, "reviews", "feature-one");
    fs.mkdirSync(path.join(temporary, "runtime"), { recursive: true });
    fs.mkdirSync(reportDirectory, { recursive: true });
    fs.writeFileSync(path.join(reportDirectory, "checkpoint-2.md"), "# Stored report\n", "utf8");
    const state = {
      version: 1,
      pairs: {
        "feature-one": { lastAutoCycle: { reportPath: "reviews/feature-one/checkpoint-2.md" } }
      }
    };
    fs.writeFileSync(path.join(temporary, "runtime", "state.json"), `${JSON.stringify(state)}\n`, "utf8");
    assert.equal(readLatestAutoReport("Feature One", temporary), "# Stored report\n");
    state.pairs["feature-one"].lastAutoCycle.reportPath = "../outside.md";
    fs.writeFileSync(path.join(temporary, "runtime", "state.json"), `${JSON.stringify(state)}\n`, "utf8");
    assert.throws(() => readLatestAutoReport("feature-one", temporary), /path is invalid/i);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("assembles every available round from the latest automatic review cycle", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-cycle-report-"));
  try {
    const reportDirectory = path.join(temporary, "reviews", "feature-one");
    fs.mkdirSync(path.join(temporary, "runtime"), { recursive: true });
    fs.mkdirSync(reportDirectory, { recursive: true });
    const round = (checkpoint, reviewRound, decision, outcome, body) => [
      "# Automatic review report - Feature One",
      "",
      `- Checkpoint: #${checkpoint} (checkpoint-${checkpoint})`,
      `- Decision: ${decision}`,
      `- Outcome: ${outcome}`,
      `- Review round: ${reviewRound}`,
      `- Started: 2026-01-01T00:00:0${reviewRound}.000Z`,
      `- Completed: 2026-01-01T00:00:0${reviewRound + 1}.000Z`,
      `- Duration: ${reviewRound}.0 seconds`,
      "",
      "## Codex report",
      "",
      body,
      ""
    ].join("\n");
    fs.writeFileSync(path.join(reportDirectory, "checkpoint-18.md"), round(18, 2, "pass", "passed", "Previous cycle complete."));
    fs.writeFileSync(path.join(reportDirectory, "checkpoint-19.md"), round(19, 1, "revise", "revision-sent", "First finding."));
    fs.writeFileSync(path.join(reportDirectory, "checkpoint-20.md"), round(
      20,
      2,
      "pass_continue",
      "continuation-sent",
      "Gate passed; continue.\n\n## Codex report\n\nNested heading remains part of this response."
    ));
    fs.writeFileSync(path.join(reportDirectory, "checkpoint-21.md"), round(21, 3, "needs_user", "waiting-user", "User choice required."));
    fs.writeFileSync(path.join(reportDirectory, "checkpoint-22.md"), round(22, 1, "needs_user", "waiting-user", "Follow-up choice required."));
    fs.writeFileSync(path.join(temporary, "runtime", "state.json"), `${JSON.stringify({
      version: 1,
      pairs: {
        "feature-one": {
          displayName: "Feature One",
          lastAutoCycle: { reportPath: "reviews/feature-one/checkpoint-22.md" }
        }
      }
    })}\n`, "utf8");

    const report = readLatestAutoReport("Feature One", temporary);
    assert.match(report, /Automatic review cycle report - Feature One/);
    assert.match(report, /Rounds: 4/);
    assert.match(report, /Checkpoints: #19 -> #22/);
    assert.match(report, /Final decision: needs_user/);
    assert.match(report, /Total review time: 7\.0 seconds/);
    assert.doesNotMatch(report, /Previous cycle complete/);
    assert.ok(report.indexOf("First finding.") < report.indexOf("Gate passed; continue."));
    assert.ok(report.indexOf("Gate passed; continue.") < report.indexOf("User choice required."));
    assert.match(report, /Nested heading remains part of this response/);
    assert.ok(report.indexOf("User choice required.") < report.indexOf("Follow-up choice required."));
    assert.match(report, /Cycle round 4 - needs_user[\s\S]*Unattended round: 1/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
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

test("paired Codex sessions preserve injected review turns in terminal scrollback", () => {
  const args = pairedCodexArguments(
    { appServerUrl: "ws://127.0.0.1:1234", codexThreadId: "thread-1" },
    "C:\\project",
    "auto",
    ["--model", "gpt-test"]
  );
  assert.deepEqual(args, [
    "--remote", "ws://127.0.0.1:1234",
    "--no-alt-screen",
    "resume", "thread-1",
    "-C", "C:\\project",
    "--profile", "bridge-auto",
    "--model", "gpt-test"
  ]);
  assert.equal(pairedCodexArguments(
    { appServerUrl: "ws://127.0.0.1:1234", codexThreadId: "thread-1" },
    "C:\\project",
    "manual",
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
  assert.match(skill, /do not switch to `\$bridge-init-tools`/);
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
    assert.equal(JSON.parse(fs.readFileSync(path.join(instance, "claude-bridge.settings.json"), "utf8")).hooks.Stop[0].hooks[0].command, "node");
    const generatedConfig = fs.readFileSync(path.join(instance, "config.toml"), "utf8");
    assert.match(generatedConfig, /\[permissions\.bridge-write\]/);
    assert.match(generatedConfig, /review_bridge_record_auto_decision/);
    assert.match(generatedConfig, /\[mcp_servers\.review_tools\]/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(instance, "review-tools.detected.json"), "utf8")).projectRoot, firstProject);

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
      templateVersion: "0.2.1", playwrightEnabled: false,
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

    fs.writeFileSync(path.join(instance, "package.json"), '{"version":"locally-modified"}\n');
    const dirty = spawnSync(process.execPath, [cli, "update"], { cwd: instance, env: environment, encoding: "utf8" });
    assert.notEqual(dirty.status, 0);
    assert.match(dirty.stderr, /Tracked reviewer files have local changes/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
