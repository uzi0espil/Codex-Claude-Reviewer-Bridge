// Opt-in: requires running hc/herdr-app and installed Codex. No model turns.
// Uses its own reviewer home, broker, two pair clients, and disposable terminals.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AppServerClient } from "../dist/app-server.js";

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtime = path.join(source, "runtime");
fs.mkdirSync(runtime, { recursive: true });
const root = fs.mkdtempSync(path.join(runtime, "herdr-lifetime-"));
const terminals = [], clients = [], spaces = [];
let endpoint;
function command(executable, args, allowFailure = false) {
  const result = spawnSync(executable, args, { encoding: "utf8", windowsHide: true, timeout: 15_000 });
  if (!allowFailure) assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
  return result.stdout ?? "";
}
async function waitFor(read, accept, timeout = 35_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { const value = await read(); if (accept(value)) return value; } catch { /* startup */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for isolated bridge lifetime test");
}
async function rpc(route, body = {}) {
  const response = await fetch(endpoint.url + route, {
    method: "POST", headers: { authorization: `Bearer ${endpoint.token}`, "content-type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(5_000)
  });
  const result = await response.json();
  assert.equal(response.ok, true, JSON.stringify(result));
  return result;
}
function launchStarter(name) {
  const script = `import('./scripts/reviewer.mjs').then(async m=>{await m.main(['ensure']);console.log('Starter ready');setInterval(()=>{},1000)}).catch(e=>{console.error(e);process.exit(1)})`;
  const terminal = JSON.parse(command("hc", ["run", "--json", "--bg", "--no-notify", "--cwd", root,
    "--name", `${name}-${path.basename(root).slice(-6).toLowerCase()}`, "--", process.execPath, "-e", script]));
  terminals.push(terminal.address);
  return terminal.address;
}
try {
  for (const directory of ["dist", "scripts"]) fs.cpSync(path.join(source, directory), path.join(root, directory), { recursive: true });
  for (const filename of ["package.json", "AGENTS.md", "review-policy.md"]) fs.copyFileSync(path.join(source, filename), path.join(root, filename));
  fs.writeFileSync(path.join(root, "bridge.local.json"), JSON.stringify({
    instanceId: path.basename(root), projectRoot: root, defaultTerminal: "herdr", desktopNotifications: false
  }));
  fs.writeFileSync(path.join(root, "config.toml"), 'approval_policy = "never"\n[features]\napps = false\nhooks = false\n[permissions.bridge-review]\nextends = ":read-only"\n');
  const starter = launchStarter("lifetime-starter");
  endpoint = await waitFor(() => JSON.parse(fs.readFileSync(path.join(root, "runtime", "endpoint.json"))), (value) => Boolean(value.herdrTerminal));
  terminals.push(endpoint.herdrTerminal);
  // Health can become ready before desktop adoption, naming, and keep-off finish.
  await waitFor(() => command("hc", ["read", starter]), (screen) => screen.includes("Starter ready"));
  const server = JSON.parse(command("hc", ["get", endpoint.herdrTerminal, "--json"]));
  assert.equal(server.parent, null);
  assert.equal(server.die_with_parent, false);
  const desktop = JSON.parse(command("herdr-app", ["ls"]));
  const space = desktop.spaces.find((space) => space.tabs?.some((tab) => tab.terminals?.some((terminal) => terminal.terminal === endpoint.herdrTerminal)));
  assert.ok(space, "Server should have its own visible space");
  await waitFor(() => JSON.parse(command("hc", ["get", endpoint.herdrTerminal, "--json"])), (value) => value.keep === false);
  assert.ok(space.tabs.every((tab) => tab.terminals.every((terminal) => terminal.terminal === endpoint.herdrTerminal)));
  spaces.push(space.id);
  assert.equal(space.name, "review-bridge");
  const second = launchStarter("lifetime-second");
  await waitFor(() => command("hc", ["read", second]), (screen) => screen.includes("Starter ready"));
  for (const feature of ["lifetime-owner", "lifetime-survivor"]) {
    const pair = await rpc("/pair/codex", { feature, projectRoot: root });
    const client = new AppServerClient(pair.appServerUrl);
    clients.push(client);
    await client.connect();
    await client.resumeThread(pair.codexThreadId, root);
  }
  const before = await rpc("/pairs");
  command("hc", ["kill", starter]);
  command("hc", ["rm", starter]);
  clients[0].close();
  const after = await rpc("/pairs");
  assert.deepEqual(after.map((pair) => pair.codexThreadId), before.map((pair) => pair.codexThreadId));
  await clients[1].resumeThread(after[1].codexThreadId, root);
  command("hc", ["kill", second]);
  command("hc", ["rm", second]);
  // Let Windows finish terminal-job cleanup, then exercise the surviving remote connection again.
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const health = await fetch(endpoint.url + "/health", { signal: AbortSignal.timeout(5_000) });
  assert.equal(health.ok, true);
  const current = JSON.parse(fs.readFileSync(path.join(root, "runtime", "endpoint.json")));
  assert.equal(current.pid, endpoint.pid);
  await clients[1].resumeThread(after[1].codexThreadId, root);
  console.log(`PASS: broker PID ${endpoint.pid} and the second pair survived closing both starter terminals.`);
} finally {
  for (const client of clients) client.close();
  if (endpoint) {
    try { await rpc("/shutdown"); } catch { /* test-owned broker may have failed */ }
  }
  for (const address of new Set(terminals)) {
    const status = JSON.parse(command("hc", ["get", address, "--json"], true) || "null");
    if (status?.state === "live") command("hc", ["kill", address], true);
    command("hc", ["rm", address], true);
  }
  for (const id of spaces) command("herdr-app", ["do", "space.close", "--id", id, "--confirmed", "true"], true);
  assert.equal(path.dirname(root), runtime);
  fs.rmSync(root, { recursive: true, force: true });
}
