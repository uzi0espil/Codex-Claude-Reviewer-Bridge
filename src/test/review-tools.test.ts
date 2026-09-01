import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { discoverReviewTools } from "../review-tools-discovery.js";
import {
  doctorReviewTools,
  loadReviewToolsManifest,
  probeReviewTools,
  recipeCommand,
  resolveHostExecutable,
  reviewToolRecipeSchema,
  reviewToolsManifestSchema,
  runCommand,
  SingleReviewToolRunner,
  validatedRepositoryPath
} from "../review-tools.js";

function fixture(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "review-tools-"));
}

test("builds host and Compose execution vectors without a shell", () => {
  const root = fixture();
  try {
    fs.writeFileSync(path.join(root, "docker-compose.yml"), "services:\n  backend:\n    image: fixture\n");
    const host = reviewToolRecipeSchema.parse({
      id: "unit_tests",
      title: "Unit tests",
      description: "Run unit tests.",
      runner: { kind: "host", command: process.execPath, args: ["test", "--workspace"], cwd: "." },
      inputs: [{ name: "targets", description: "Test targets.", type: "repo_paths" }]
    });
    const hostSpec = recipeCommand(host, { targets: ["crates/core"] }, root);
    assert.equal(hostSpec.command, process.execPath);
    assert.deepEqual(hostSpec.args, ["test", "--workspace", "crates/core"]);

    const compose = reviewToolRecipeSchema.parse({
      id: "backend_tests",
      title: "Backend tests",
      description: "Run tests in the backend service.",
      runner: {
        kind: "compose_exec",
        files: ["docker-compose.yml"],
        service: "backend",
        workdir: "/app",
        command: "dotnet",
        args: ["test", "--no-restore"],
        cwd: "."
      }
    });
    const composeSpec = recipeCommand(compose, {}, root);
    assert.equal(composeSpec.command, "docker");
    assert.deepEqual(composeSpec.args.slice(0, 8), ["compose", "-f", "docker-compose.yml", "exec", "-T", "-w", "/app", "backend"]);
    assert.deepEqual(composeSpec.args.slice(-3), ["dotnet", "test", "--no-restore"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("renders typed inputs and a language-neutral staged command", () => {
  const root = fixture();
  try {
    fs.writeFileSync(path.join(root, "compose.yml"), "services:\n  runner:\n    image: fixture\n");
    fs.mkdirSync(path.join(root, "tools", "benchmark"), { recursive: true });
    fs.writeFileSync(path.join(root, "tools", "benchmark", "run.mjs"), "console.log('ok')\n");
    const recipe = reviewToolRecipeSchema.parse({
      id: "node_benchmark",
      title: "Node benchmark",
      description: "Run a staged Node benchmark.",
      runner: {
        kind: "compose_stage_exec",
        files: ["compose.yml"],
        service: "runner",
        sourceDirectory: "tools/benchmark",
        workdir: "{stage}",
        command: "node",
        args: ["{stage}/tools/benchmark/run.mjs"],
        artifacts: ["tools/benchmark/results/{input:output}.json"],
        cwd: "."
      },
      inputs: [
        { name: "mode", description: "Benchmark mode.", type: "enum", values: ["smoke", "full"], default: "smoke", flag: "--mode" },
        { name: "output", description: "Output stem.", type: "string", required: true, pattern: "^[A-Za-z0-9_.-]+$", flag: "--output", valueTemplate: "{stage}/tools/benchmark/results/{value}.json" },
        { name: "arguments", description: "Approved extra argv.", type: "strings" }
      ]
    });
    const stage = "/tmp/review-tools/run/repo";
    const spec = recipeCommand(recipe, { output: "card", arguments: ["--tag", "semi;colon"] }, root, stage);
    assert.equal(spec.args.includes("sh"), false);
    assert.equal(spec.args.includes("semi;colon"), true);
    assert.equal(spec.args.includes(`${stage}/tools/benchmark/run.mjs`), true);
    assert.equal(spec.args.includes(`${stage}/tools/benchmark/results/card.json`), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects repository escapes, flag-shaped paths, and control characters", () => {
  const root = fixture();
  try {
    assert.throws(() => validatedRepositoryPath(root, "../outside", "target"), /leaves the bound repository/);
    assert.throws(() => validatedRepositoryPath(root, "--collect-only", "target"), /Invalid target/);
    const recipe = reviewToolRecipeSchema.parse({
      id: "script_check",
      title: "Script check",
      description: "Run a script.",
      runner: { kind: "host", command: "node", args: ["verify.mjs"], cwd: "." },
      inputs: [{ name: "arguments", description: "Arguments.", type: "strings" }]
    });
    assert.throws(() => recipeCommand(recipe, { arguments: ["ok\nwhoami"] }, root), /control characters/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolves npm-style Windows shims to Node argv without cmd.exe", { skip: process.platform !== "win32" }, () => {
  const root = fixture();
  try {
    const script = path.join(root, "node_modules", "fixture", "cli.js");
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(script, "console.log('fixture')\n");
    const shim = path.join(root, "fixture.cmd");
    fs.writeFileSync(shim, '@ECHO off\r\n"node" "%~dp0\\node_modules\\fixture\\cli.js" %*\r\n');
    const resolved = resolveHostExecutable(shim, root);
    assert.equal(resolved.command, process.execPath);
    assert.deepEqual(resolved.argsPrefix, [script]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("loads only a manifest bound to the selected project", () => {
  const root = fixture();
  const other = fixture();
  const manifestPath = path.join(root, "manifest.json");
  try {
    fs.writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 1, projectRoot: root, approvedAt: new Date().toISOString(), tools: [] }));
    const loaded = loadReviewToolsManifest(manifestPath, root);
    assert.equal(loaded.projectRoot, root);
    assert.equal(loaded.readinessDefaults.mode, "static");
    assert.throws(() => loadReviewToolsManifest(manifestPath, other), /not/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(other, { recursive: true, force: true });
  }
});

test("doctor distinguishes host readiness from container runtime probes", () => {
  const root = fixture();
  try {
    fs.writeFileSync(path.join(root, "compose.yml"), "services:\n  runner:\n    image: fixture\n");
    const host = reviewToolRecipeSchema.parse({
      id: "host_check", title: "Host check", description: "Check Node.",
      runner: { kind: "host", command: process.execPath, args: ["--version"], cwd: "." }
    });
    const container = reviewToolRecipeSchema.parse({
      id: "container_check", title: "Container check", description: "Check a container tool.",
      runner: { kind: "compose_exec", files: ["compose.yml"], service: "runner", command: "cargo", args: ["test"], cwd: "." }
    });
    const manifest = reviewToolsManifestSchema.parse({
      schemaVersion: 1,
      projectRoot: root,
      approvedAt: new Date().toISOString(),
      tools: [host, container]
    });
    const result = doctorReviewTools(manifest, root, () => true);
    assert.equal(result.ready, true);
    assert.equal(result.allReady, false);
    assert.equal(result.tools[0].status, "ready");
    assert.equal(result.tools[0].basis, "static");
    assert.equal(result.tools[1].status, "needs_runtime_probe");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("doctor honors global trusted readiness and per-tool overrides without hiding structural failures", () => {
  const root = fixture();
  try {
    fs.writeFileSync(path.join(root, "compose.yml"), "services:\n  runner:\n    image: fixture\n");
    const manifest = reviewToolsManifestSchema.parse({
      schemaVersion: 1,
      projectRoot: root,
      approvedAt: new Date().toISOString(),
      readinessDefaults: { mode: "trusted" },
      tools: [
        {
          id: "trusted_container",
          title: "Trusted container",
          description: "Use an explicitly trusted runtime assumption.",
          runner: { kind: "compose_exec", files: ["compose.yml"], service: "runner", command: "cargo", args: ["test"], cwd: "." }
        },
        {
          id: "static_container",
          title: "Static container",
          description: "Keep the static default for this tool.",
          runner: { kind: "compose_exec", files: ["compose.yml"], service: "runner", command: "cargo", args: ["test"], cwd: "." },
          readiness: { mode: "static" }
        },
        {
          id: "missing_container",
          title: "Missing container",
          description: "A trusted tool with a structural problem.",
          runner: { kind: "compose_exec", files: ["missing.yml"], service: "runner", command: "cargo", args: ["test"], cwd: "." }
        },
        {
          id: "missing_probe_executable",
          title: "Missing probe executable",
          description: "A probe whose host executable is unavailable.",
          runner: { kind: "host", command: process.execPath, args: ["--version"], cwd: "." },
          readiness: {
            mode: "probe",
            runner: { kind: "host", command: "missing-probe", args: ["--version"], cwd: "." }
          }
        }
      ]
    });
    const result = doctorReviewTools(manifest, root, (command) => command !== "missing-probe");
    assert.equal(result.ready, false);
    assert.equal(result.allReady, false);
    assert.equal(result.tools[0].status, "ready");
    assert.equal(result.tools[0].basis, "user_trusted");
    assert.equal(result.tools[1].status, "needs_runtime_probe");
    assert.equal(result.tools[2].status, "missing");
    assert.equal(result.tools[3].status, "missing");
    assert.match(result.tools[3].issues[0], /probe executable is unavailable/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("approved readiness probes produce cached ready and failed states", async () => {
  const root = fixture();
  try {
    const manifest = reviewToolsManifestSchema.parse({
      schemaVersion: 1,
      projectRoot: root,
      approvedAt: new Date().toISOString(),
      tools: [
        {
          id: "passing_probe",
          title: "Passing probe",
          description: "Use a passing fixed readiness probe.",
          runner: { kind: "host", command: process.execPath, args: ["--version"], cwd: "." },
          readiness: {
            mode: "probe",
            runner: { kind: "host", command: process.execPath, args: ["-e", "process.exit(0)"], cwd: "." },
            timeoutSeconds: 10,
            cacheSeconds: 60
          }
        },
        {
          id: "failing_probe",
          title: "Failing probe",
          description: "Use a failing fixed readiness probe.",
          runner: { kind: "host", command: process.execPath, args: ["--version"], cwd: "." },
          readiness: {
            mode: "probe",
            runner: { kind: "host", command: process.execPath, args: ["-e", "process.exit(7)"], cwd: "." },
            timeoutSeconds: 10,
            cacheSeconds: 60
          }
        }
      ]
    });
    const before = doctorReviewTools(manifest, root, () => true);
    assert.deepEqual(before.tools.map(({ status }) => status), ["needs_runtime_probe", "needs_runtime_probe"]);
    const probed = await probeReviewTools(new SingleReviewToolRunner(), manifest, undefined, root);
    assert.equal(probed.results.passing_probe.success, true);
    assert.equal(probed.results.failing_probe.exitCode, 7);
    const after = doctorReviewTools(manifest, root, () => true, probed.results);
    assert.equal(after.ready, false);
    assert.equal(after.allReady, false);
    assert.equal(after.tools[0].status, "ready");
    assert.equal(after.tools[0].basis, "runtime_probe");
    assert.equal(after.tools[1].status, "failed");
    assert.match(after.tools[1].issues[0], /exited with code 7/);
    const expired = {
      ...probed.results,
      passing_probe: {
        ...probed.results.passing_probe,
        expiresAt: new Date(Date.now() - 1_000).toISOString()
      }
    };
    assert.equal(doctorReviewTools(manifest, root, () => true, expired).tools[0].status, "needs_runtime_probe");
    await assert.rejects(
      probeReviewTools(new SingleReviewToolRunner(), manifest, ["unknown_tool"], root),
      /Unknown approved review tool id/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("discovers multiple language ecosystems and Compose capabilities", () => {
  const root = fixture();
  try {
    fs.mkdirSync(path.join(root, "frontend"), { recursive: true });
    fs.writeFileSync(path.join(root, "frontend", "package.json"), JSON.stringify({ scripts: { test: "vitest run", lint: "eslint .", dev: "vite" } }));
    fs.writeFileSync(path.join(root, "frontend", "package-lock.json"), "{}");
    fs.mkdirSync(path.join(root, "python"), { recursive: true });
    fs.writeFileSync(path.join(root, "python", "pyproject.toml"), "[dependency-groups]\ndev = ['pytest', 'ruff']\n[tool.pytest.ini_options]\n");
    fs.mkdirSync(path.join(root, "rust"), { recursive: true });
    fs.writeFileSync(path.join(root, "rust", "Cargo.toml"), "[package]\nname='fixture'\nversion='0.1.0'\n");
    fs.mkdirSync(path.join(root, "go"), { recursive: true });
    fs.writeFileSync(path.join(root, "go", "go.mod"), "module fixture\n");
    fs.writeFileSync(path.join(root, "uv.lock"), "version = 1\n");
    fs.mkdirSync(path.join(root, "scripts", "benchmark"), { recursive: true });
    fs.writeFileSync(path.join(root, "scripts", "benchmark", "run.py"), "print('fixture')\n");
    fs.writeFileSync(path.join(root, "docker-compose.yml"), "services:\n  api:\n    image: fixture\n  db:\n    image: postgres\n");
    const discovery = discoverReviewTools(root);
    const technologyIds = discovery.technologies.map(({ id }) => id);
    assert.equal(technologyIds.includes("javascript-typescript"), true);
    assert.equal(technologyIds.includes("python"), true);
    assert.equal(technologyIds.includes("rust"), true);
    assert.equal(technologyIds.includes("go"), true);
    assert.equal(technologyIds.includes("docker-compose"), true);
    const ids = discovery.candidates.map(({ recipe }) => recipe.id);
    assert.equal(ids.includes("frontend_test"), true);
    assert.equal(ids.includes("python_pytest"), true);
    assert.equal(ids.includes("rust_cargo_test"), true);
    assert.equal(ids.includes("go_go_test"), true);
    assert.equal(ids.includes("compose_logs"), true);
    const logs = discovery.candidates.find(({ recipe }) => recipe.id === "compose_logs")!.recipe;
    assert.deepEqual((logs.inputs.find(({ name }) => name === "service") as { values: string[] }).values, ["api", "db"]);
    const script = discovery.candidates.find(({ recipe }) => recipe.evidence.includes("scripts/benchmark/run.py"))!.recipe;
    assert.deepEqual(script.runner.kind === "host" ? script.runner.args : [], ["run", "--frozen", "--no-sync", "python", "scripts/benchmark/run.py"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("reports nonzero command exits as execution evidence", async () => {
  const root = fixture();
  try {
    const result = await runCommand({
      command: process.execPath,
      args: ["-e", "process.stdout.write('out'); process.stderr.write('err'); process.exit(7)"],
      cwd: root,
      timeoutMs: 10_000,
      label: "fixture"
    });
    assert.equal(result.exitCode, 7);
    assert.equal(result.stdout, "out");
    assert.equal(result.stderr, "err");
    assert.equal(result.timedOut, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("terminates commands that exceed their approved timeout", async () => {
  const root = fixture();
  try {
    const result = await runCommand({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: root,
      timeoutMs: 50,
      label: "timeout_fixture"
    });
    assert.equal(result.timedOut, true);
    assert.notEqual(result.signal === null && result.exitCode === 0, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
