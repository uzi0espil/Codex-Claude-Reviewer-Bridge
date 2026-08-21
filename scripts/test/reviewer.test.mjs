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
  powershellQuote,
  shellQuote,
  terminalLaunchSpec,
  tomlLiteral,
  validateCommandArguments
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

test("generates portable Claude hooks and Codex configuration", () => {
  const settings = claudeSettings("/tmp/project");
  assert.equal(settings.hooks.PreToolUse[0].matcher, "AskUserQuestion");
  assert.equal(settings.hooks.Stop[0].hooks[0].command, "node");
  const config = codexConfig("/tmp/project with spaces", true);
  assert.match(config, /web_search = "live"/);
  assert.match(config, /\[permissions\.bridge-review\]/);
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
    for (const directory of [scripts, commands, path.join(firstProject, ".git"), path.join(secondProject, ".git")]) {
      fs.mkdirSync(directory, { recursive: true });
    }
    fs.copyFileSync(fileURLToPath(new URL("../reviewer.mjs", import.meta.url)), path.join(scripts, "reviewer.mjs"));
    fs.mkdirSync(path.join(scripts, "powershell"), { recursive: true });
    fs.mkdirSync(path.join(scripts, "powershell", "internal"), { recursive: true });
    fs.copyFileSync(fileURLToPath(new URL("../powershell/internal/Run-External.ps1", import.meta.url)), path.join(scripts, "powershell", "internal", "Run-External.ps1"));
    fs.writeFileSync(path.join(instance, "package.json"), '{"version":"test-version"}\n');

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
    assert.match(fs.readFileSync(path.join(instance, "config.toml"), "utf8"), /\[permissions\.bridge-write\]/);

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
