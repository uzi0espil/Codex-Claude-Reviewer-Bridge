// Opt-in: consumes real Claude/Codex capacity in a disposable private instance.
// Run after npm run build. Never connects to the factory broker.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
fs.mkdirSync(path.join(source, "runtime"), { recursive: true });
const root = fs.mkdtempSync(path.join(source, "runtime", "force-publish-live-"));
const instance = path.join(root, "reviewer");
const project = path.join(root, "project");
const feature = "force-publish-smoke";
const session = randomUUID();
const marker = `DELIVERY_${randomUUID().replaceAll("-", "")}`;
const evidence = { root, checks: [] };
const check = (description) => { evidence.checks.push(description); console.log(description); };
let broker, endpoint, pair, relay, remoteUrl;
const children = new Set();
fs.mkdirSync(instance); fs.mkdirSync(project);
for (const entry of ["dist", "skills", "scripts"]) fs.cpSync(path.join(source, entry), path.join(instance, entry), { recursive: true });
for (const entry of ["package.json", "review-policy.md"]) fs.copyFileSync(path.join(source, entry), path.join(instance, entry));
fs.symlinkSync(path.join(source, "node_modules"), path.join(instance, "node_modules"), process.platform === "win32" ? "junction" : "dir");
const auth = [path.join(os.homedir(), ".codex", "auth.json"), path.join(source, "auth.json")].find(fs.existsSync);
assert.ok(auth, "An existing Codex login is required.");
const { codexConfig, claudeSettings } = await import(pathToFileURL(path.join(instance, "scripts", "reviewer.mjs")).href);
fs.writeFileSync(path.join(instance, "config.toml"), codexConfig(project, true));
fs.writeFileSync(path.join(instance, "claude-bridge.settings.json"), JSON.stringify(claudeSettings(project, false)));
fs.writeFileSync(path.join(instance, "bridge.local.json"), JSON.stringify({ projectRoot: project, projectName: "Force publication smoke", defaultMode: "auto", desktopNotifications: false }));
fs.writeFileSync(path.join(project, "README.md"), "# Disposable bridge fixture\nThe user only requests conversational acknowledgments and a controlled hold command. No implementation is requested.\n");
fs.writeFileSync(path.join(project, "AGENTS.md"), "Disposable integration fixture. Reviews are read-only. Conversational acknowledgments and running node hold.mjs are explicitly authorized. The hold command only creates ready.txt and waits for release.txt in this fixture. No other changes or external actions are authorized. Completed conversational requests should pass without further continuation.\n");
fs.writeFileSync(path.join(project, "hold.mjs"), `import fs from 'node:fs';
fs.writeFileSync('ready.txt', 'ready');
const deadline = Date.now() + 240000;
while (!fs.existsSync('release.txt')) {
  if (Date.now() > deadline) throw new Error('Hold timed out');
  await new Promise(resolve => setTimeout(resolve, 200));
}
console.log('Hold released.');
`);
const env = { ...process.env, CODEX_HOME: instance, REVIEW_BRIDGE_FEATURE: feature };
const codexScript = path.join(process.env.APPDATA ?? "", "npm", "node_modules", "@openai", "codex", "bin", "codex.js");
const codex = fs.existsSync(codexScript) ? process.execPath : "codex";
const codexPrefix = fs.existsSync(codexScript) ? [codexScript] : [];
const claude = path.join(os.homedir(), ".local", "bin", process.platform === "win32" ? "claude.exe" : "claude");
const claudeArgs = ["-p", "--output-format", "json", "--settings", path.join(instance, "claude-bridge.settings.json"), "--setting-sources", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}'];

async function run(command, args, label) {
  const child = spawn(command, args, { cwd: project, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  let stdout = "", stderr = "";
  child.stdout.on("data", data => { stdout += String(data); });
  child.stderr.on("data", data => { stderr += String(data); });
  const timer = setTimeout(() => child.kill(), 300_000);
  try {
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
    fs.writeFileSync(path.join(root, `${label}.log`), stdout + "\n" + stderr, { mode: 0o600 });
    assert.equal(code, 0, `${label} failed; private logs: ${root}`);
    return stdout;
  } finally { clearTimeout(timer); children.delete(child); }
}
async function until(read, predicate, timeout = 240_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read(); if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Live smoke test timed out; private evidence: ${root}`);
}
async function call(route, body = {}) {
  const response = await fetch(endpoint.url + route, { method: "POST", headers: { authorization: `Bearer ${endpoint.token}`, "content-type": "application/json" }, body: JSON.stringify({ feature, ...body }) });
  const value = await response.json(); assert.ok(response.ok, value.error); return value;
}
async function start() {
  broker = spawn(process.execPath, [path.join(instance, "dist", "broker.js")], { cwd: instance, env, windowsHide: true, stdio: "ignore" });
  endpoint = await until(() => {
    if (broker.exitCode !== null) throw new Error("Live broker exited; inspect its private runtime/bridge.log");
    try { return JSON.parse(fs.readFileSync(path.join(instance, "runtime", "endpoint.json"), "utf8")); } catch { return undefined; }
  }, Boolean, 30_000);
  pair = await call("/pair/codex", { projectRoot: project });
  // Some codex exec versions accept only origin URLs. Keep the real pair-bound
  // route by forwarding a disposable origin socket to the broker's capability URL.
  if (relay) { for (const socket of relay.clients) socket.terminate(); relay.close(); }
  relay = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(relay, "listening");
  remoteUrl = `ws://127.0.0.1:${relay.address().port}`;
  relay.on("connection", client => {
    const upstream = new WebSocket(pair.appServerUrl);
    const queued = [];
    client.on("message", data => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data.toString());
      else queued.push(data.toString());
    });
    upstream.on("open", () => { for (const message of queued) upstream.send(message); });
    upstream.on("message", data => { if (client.readyState === WebSocket.OPEN) client.send(data.toString()); });
    client.on("close", () => upstream.close());
    upstream.on("close", () => client.close());
    client.on("error", () => upstream.terminate());
    upstream.on("error", () => client.terminate());
  });
}
async function command(skill, instruction, label) {
  return run(codex, [...codexPrefix, "exec", "resume", "--remote", remoteUrl, "--skip-git-repo-check", "--json", pair.codexThreadId,
    `Interactive user request for feature '${feature}': use $bridge-${skill}. ${instruction} This is explicit user authorization for that bridge operation only. Do not edit files or run project commands.`], label);
}
async function passed() {
  const result = await until(() => call("/status"), value => ["passed", "waiting-user", "failed"].includes(value.status) || value.activity === "standby");
  assert.equal(result.status, "passed", `Expected real auto review to pass: ${JSON.stringify(result)}`);
  return result;
}
try {
  fs.copyFileSync(auth, path.join(instance, "auth.json"));
  fs.chmodSync(path.join(instance, "auth.json"), 0o600);
  await start();
  await call("/pair/claude", { projectRoot: project, sessionId: session });
  await call("/mode", { mode: "auto", roundLimit: 3 });
  await run(claude, [...claudeArgs, "--tools", "", "--session-id", session,
    "This is a conversational bridge test. Reply only FIRST_COMPLETE. This completes this request. Do not use tools or change files."], "claude-first");
  const first = await passed();
  check("Real Claude handoff received a real Codex automatic pass.");

  const working = run(claude, [...claudeArgs, "--tools", "Bash", "--allowedTools", "Bash(node hold.mjs)", "--resume", session,
    "For this controlled test, run node hold.mjs using Bash in the current directory. Wait for it to complete (poll its task if it runs in background). Then reply only SECOND_COMPLETE. Running this fixture command is authorized; no other work is requested."], "claude-held");
  // Attach a rejection handler while waiting for the fixture signal.
  working.catch(() => {});
  await until(() => fs.existsSync(path.join(project, "ready.txt")), Boolean, 60_000);
  await command("force-publish", `Send exactly: The delivery marker is ${marker}. When the user asks for the queued delivery marker, reply with that exact marker.`, "codex-force-publish");
  const queued = await call("/status");
  assert.ok(queued.explicitClaudeMessage);
  assert.equal(queued.mode, "auto"); assert.equal(queued.autoRound, first.autoRound); assert.equal(queued.autoRoundLimit, 3);
  const messageId = queued.explicitClaudeMessage.id;
  check("Actual $bridge-force-publish queued explicit feedback while real Claude was working in auto mode.");
  fs.writeFileSync(path.join(project, "release.txt"), "release");
  await working;
  const newer = await passed();
  assert.ok(newer.checkpointSequence > first.checkpointSequence);
  assert.equal(newer.explicitClaudeMessage.id, messageId);
  check("A newer real Claude Stop and real Codex review preserved the explicit message.");

  await call("/shutdown");
  await until(() => broker.exitCode, code => code !== null, 10_000);
  await start();
  assert.equal((await call("/status")).explicitClaudeMessage.id, messageId);
  check("Isolated broker restart preserved the queued message and its ID.");
  const delivered = await run(claude, [...claudeArgs, "--tools", "", "--resume", session,
    "What delivery marker did the queued explicit feedback provide? Reply only with that marker. This completes my request."], "claude-delivery");
  assert.equal(JSON.parse(delivered).result.trim(), marker);
  await passed();
  assert.equal((await call("/status")).explicitClaudeMessage, undefined);
  check("Real Claude received and returned the queued marker on its next user prompt; queue was consumed.");

  await command("force-publish", "Send exactly: Disposable feedback to discard before delivery.", "codex-queue-discard");
  const discardId = (await call("/status")).explicitClaudeMessage.id;
  await command("discard-message", "Discard the currently queued explicit message.", "codex-discard");
  assert.equal((await call("/status")).explicitClaudeMessage, undefined);
  evidence.discardedMessageId = discardId;
  check("Actual $bridge-discard-message removed the queued message without changing auto mode.");
  assert.equal((await call("/status")).mode, "auto");
  evidence.passed = true;
} catch (error) {
  evidence.error = String(error); throw error;
} finally {
  // Release the owned fixture before stopping children, even after an assertion.
  fs.writeFileSync(path.join(project, "release.txt"), "release");
  for (const child of children) child.kill();
  if (endpoint) { try {
    await call("/shutdown");
    await until(() => broker.exitCode, code => code !== null, 6_000);
  } catch {} }
  broker?.kill();
  if (relay) { for (const socket of relay.clients) socket.terminate(); relay.close(); }
  fs.rmSync(path.join(instance, "auth.json"), { force: true });
  fs.writeFileSync(path.join(root, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
  console.log(`Private live-test evidence: ${root}`);
}
