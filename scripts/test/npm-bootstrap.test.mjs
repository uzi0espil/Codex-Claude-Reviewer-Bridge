import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { main as bootstrapMain, parseBootstrapArguments, templateSelection } from "../npm-bootstrap.mjs";

test("parses the npx create command and rejects runtime commands", () => {
  assert.deepEqual(
    parseBootstrapArguments(["create", "--project-root", "/tmp/app", "--skip-playwright"]),
    { command: "create", options: { "project-root": "/tmp/app", "skip-playwright": true } }
  );
  assert.deepEqual(
    parseBootstrapArguments(["--project-root", "/tmp/app"]),
    { command: "create", options: { "project-root": "/tmp/app" } }
  );
  assert.throws(() => parseBootstrapArguments(["create", "extra"]), /Unexpected argument/);
  assert.throws(() => bootstrapMain(["start-pair"]), /supports only 'create'/);
  assert.deepEqual(templateSelection({}, "1.2.3"), {
    repository: "https://github.com/uzi0espil/Codex-Claude-Reviewer-Bridge.git",
    templateRef: "v1.2.3"
  });
  assert.deepEqual(templateSelection({ "template-repository": "ssh://example/reviewer.git" }, "1.2.3"), {
    repository: "ssh://example/reviewer.git",
    templateRef: undefined
  });
});

test("the npx bootstrapper clones a pinned template and preserves its update upstream", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-npx-"));
  const git = (args, cwd) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout.trim();
  };
  try {
    const origin = path.join(temporary, "origin.git");
    const seed = path.join(temporary, "seed");
    const destination = path.join(temporary, "reviewer");
    const project = path.join(temporary, "application");
    const commands = path.join(temporary, "commands");
    fs.mkdirSync(seed, { recursive: true });
    fs.mkdirSync(path.join(project, ".git"), { recursive: true });
    fs.mkdirSync(commands, { recursive: true });
    git(["init", "--bare", origin], temporary);
    git(["init", "-b", "main"], seed);
    git(["config", "user.email", "tests@example.invalid"], seed);
    git(["config", "user.name", "Reviewer Tests"], seed);

    for (const directory of [
      path.join(seed, "scripts", "powershell", "internal"),
      path.join(seed, "scripts", "shell"),
      path.join(seed, "skills", "bridge-init-policy")
    ]) fs.mkdirSync(directory, { recursive: true });
    fs.copyFileSync(fileURLToPath(new URL("../reviewer.mjs", import.meta.url)), path.join(seed, "scripts", "reviewer.mjs"));
    fs.copyFileSync(
      fileURLToPath(new URL("../powershell/internal/Run-External.ps1", import.meta.url)),
      path.join(seed, "scripts", "powershell", "internal", "Run-External.ps1")
    );
    fs.writeFileSync(path.join(seed, "scripts", "powershell", "reviewer.ps1"), "# fixture\n");
    fs.writeFileSync(path.join(seed, "scripts", "shell", "reviewer.sh"), "#!/bin/sh\n");
    fs.writeFileSync(path.join(seed, "skills", "bridge-init-policy", "SKILL.md"), "# fixture\n");
    fs.writeFileSync(path.join(seed, ".gitignore"), "/bridge.local.json\n/claude-bridge.settings.json\n/config.toml\n/runtime/\n");
    fs.writeFileSync(path.join(seed, "package.json"), '{"version":"0.3.2"}\n');
    git(["add", "."], seed);
    git(["commit", "-m", "release fixture"], seed);
    git(["tag", "v0.3.2"], seed);
    git(["remote", "add", "origin", origin], seed);
    git(["push", "-u", "origin", "main", "--tags"], seed);
    git(["symbolic-ref", "HEAD", "refs/heads/main"], origin);
    fs.writeFileSync(path.join(seed, "unreleased.txt"), "not in the package release\n");
    git(["add", "unreleased.txt"], seed);
    git(["commit", "-m", "unreleased change"], seed);
    git(["push"], seed);

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
    const bootstrap = fileURLToPath(new URL("../npm-bootstrap.mjs", import.meta.url));
    const created = spawnSync(process.execPath, [
      bootstrap,
      "create",
      "--project-root", project,
      "--destination", destination,
      "--template-repository", origin,
      "--template-ref", "v0.3.2",
      "--skip-playwright"
    ], { cwd: temporary, env: environment, encoding: "utf8" });
    assert.equal(created.status, 0, created.stderr || created.stdout);
    assert.equal(fs.existsSync(path.join(destination, "unreleased.txt")), false);
    assert.equal(git(["branch", "--show-current"], destination), "reviewer-v0.3.2");
    assert.equal(git(["rev-parse", "--abbrev-ref", "@{upstream}"], destination), "origin/main");
    assert.equal(JSON.parse(fs.readFileSync(path.join(destination, "bridge.local.json"), "utf8")).templateVersion, "0.3.2");
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
