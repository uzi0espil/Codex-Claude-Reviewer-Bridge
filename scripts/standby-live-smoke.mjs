// Opt-in live test. Uses real Claude/Codex capacity in a private disposable
// instance; never connects to the factory broker or modifies its configuration.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = fs.mkdtempSync(path.join(source, "runtime", "standby-live-"));
const instance = path.join(root, "reviewer");
const project = path.join(root, "project");
const feature = "standby-smoke";
const session = randomUUID();
let broker;
let endpoint;
const evidence = { root, checks: [] };
const check = (description) => { evidence.checks.push(description); console.log(description); };
fs.mkdirSync(instance); fs.mkdirSync(project);
for (const entry of ["dist", "skills", "scripts"]) fs.cpSync(path.join(source, entry), path.join(instance, entry), { recursive: true });
fs.copyFileSync(path.join(source, "package.json"), path.join(instance, "package.json"));
fs.symlinkSync(path.join(source, "node_modules"), path.join(instance, "node_modules"), process.platform === "win32" ? "junction" : "dir");
const auth = [path.join(os.homedir(), ".codex", "auth.json"), path.join(source, "auth.json")].find(fs.existsSync);
if (!auth) throw new Error("No existing Codex login available for isolated smoke test.");
const { codexConfig, claudeSettings } = await import(pathToFileURL(path.join(instance, "scripts", "reviewer.mjs")).href);
fs.writeFileSync(path.join(instance, "config.toml"), codexConfig(project, true));
fs.writeFileSync(path.join(instance, "claude-bridge.settings.json"), JSON.stringify(claudeSettings(project, false)));
fs.writeFileSync(path.join(instance, "bridge.local.json"), JSON.stringify({ projectRoot: project, projectName: "Standby smoke", defaultMode: "auto", desktopNotifications: false }));
fs.writeFileSync(path.join(project, "README.md"), "# Standby smoke fixture\n\nThis disposable project tests context retention. No implementation changes are requested.\n");
fs.writeFileSync(path.join(project, "AGENTS.md"), "This is a disposable bridge integration test. Reviews are read-only. Inspect README.md as needed. The user only requested conversational acknowledgments; no code changes or external actions are authorized.\n");
const env = { ...process.env, CODEX_HOME: instance, REVIEW_BRIDGE_FEATURE: feature };
const codexScript = path.join(process.env.APPDATA ?? "", "npm", "node_modules", "@openai", "codex", "bin", "codex.js");
const codexCommand = fs.existsSync(codexScript) ? process.execPath : "codex";
const codexPrefix = fs.existsSync(codexScript) ? [codexScript] : [];

async function run(command, args, label, options = {}) {
  const child = spawn(command, args, { cwd: project, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], ...options });
  let stdout = "", stderr = "";
  child.stdout.on("data", (data) => { stdout += String(data); });
  child.stderr.on("data", (data) => { stderr += String(data); });
  const timer = setTimeout(() => child.kill(), 180_000);
  const result = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code) => resolve(code)); });
  clearTimeout(timer);
  fs.writeFileSync(path.join(root, `${label}.log`), stdout + "\n" + stderr, { mode: 0o600 });
  assert.equal(result, 0, `${label} failed; inspect its private log in ${root}`);
  return stdout;
}
async function until(read, predicate, timeout = 180_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await read(); if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Live smoke test timed out");
}
async function call(route, body = {}) {
  const response = await fetch(endpoint.url + route, { method: "POST", headers: { authorization: `Bearer ${endpoint.token}`, "content-type": "application/json" }, body: JSON.stringify({ feature, ...body }) });
  const value = await response.json();
  assert.ok(response.ok, value.error); return value;
}
async function start() {
  broker = spawn(process.execPath, [path.join(instance, "dist", "broker.js")], { cwd: instance, env, windowsHide: true, stdio: "ignore" });
  endpoint = await until(() => {
    if (broker.exitCode !== null) throw new Error("Live broker exited; inspect its runtime/bridge.log");
    try { return JSON.parse(fs.readFileSync(path.join(instance, "runtime", "endpoint.json"), "utf8")); } catch { return undefined; }
  }, Boolean, 30_000);
}
async function command(name) {
  await run(codexCommand, [...codexPrefix, "exec", "--skip-git-repo-check", "--json", "-C", project,
    `Use $bridge-${name} for the paired feature '${feature}'. Call only review_bridge_${name} with that exact feature. Do not change mode, inspect project files, or perform other work. Report the tool result briefly.`], `codex-${name}`);
}
try {
  fs.copyFileSync(auth, path.join(instance, "auth.json"));
  fs.chmodSync(path.join(instance, "auth.json"), 0o600);
  await start();
  await call("/pair/claude", { projectRoot: project, sessionId: session });
  await call("/pair/codex", { projectRoot: project });
  await call("/mode", { mode: "auto", roundLimit: 2 });
  await command("standby");
  assert.equal((await call("/status")).activity, "standby");
  check("Actual $bridge-standby command entered standby in the isolated instance.");
  const claude = path.join(os.homedir(), ".local", "bin", process.platform === "win32" ? "claude.exe" : "claude");
  const claudeArgs = ["-p", "--output-format", "json", "--settings", path.join(instance, "claude-bridge.settings.json"), "--setting-sources", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--tools", ""];
  await run(claude, [...claudeArgs, "--session-id", session,
    "This is a conversational bridge test. Remember the test color is cerulean. Reply only: First handoff: cerulean. Do not use tools or change files."], "claude-first");
  await run(claude, [...claudeArgs, "--resume", session,
    "The test color is now vermilion. Reply only: Final handoff: vermilion. This completes my request. Do not use tools or change files."], "claude-second");
  const before = await call("/status");
  assert.equal(before.activity, "standby");
  assert.ok(before.backlog.prompts >= 2 && before.backlog.handoffs >= 2, "Real Claude hooks did not capture two exchanges");
  assert.equal(before.pending, undefined);
  check("Two real Claude exchanges were captured while reviews remained on standby.");
  await call("/shutdown");
  await until(async () => broker.exitCode, (code) => code !== null, 10_000);
  await start();
  const restored = await call("/status");
  assert.equal(restored.activity, "standby"); assert.equal(restored.backlog.handoffs, before.backlog.handoffs);
  check("Broker restart retained standby and the complete captured backlog.");
  await command("resume");
  const result = await until(() => call("/status"), (value) => value.activity === "standby"
    || (value.activity === "active" && (value.status === "passed" || value.status === "waiting-user" || value.status === "waiting-claude")));
  assert.equal(result.activity, "active", `Recovery did not finish: ${result.standby?.reason}`);
  assert.equal(result.backlog.records, 0);
  assert.equal(result.autoRoundLimit, 2);
  const state = JSON.parse(fs.readFileSync(path.join(instance, "runtime", "state.json"), "utf8")).pairs[feature];
  assert.ok(!state.pending || state.pending.claudeMessage.includes("vermilion"));
  evidence.finalStatus = result.status;
  check(`Actual $bridge-resume caught up and completed a real Codex review (${result.status}).`);
  const report = await call("/report", { full: true });
  fs.writeFileSync(path.join(root, "review-report.md"), report.report);
} finally {
  if (endpoint) { try {
    await call("/shutdown");
    await until(async () => broker.exitCode, (code) => code !== null, 6_000);
  } catch {} }
  broker?.kill();
  // Remove only the temporary auth copy owned by this test, never the login source.
  fs.rmSync(path.join(instance, "auth.json"), { force: true });
  fs.writeFileSync(path.join(root, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
  console.log(`Private smoke-test evidence: ${root}`);
}
