// Opt-in protocol smoke test against the installed Codex app-server. Uses an
// isolated CODEX_HOME and disposable projects; no login or model turns needed.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { AppServerClient } from "../dist/app-server.js";
import { AppServerProxy } from "../dist/app-server-proxy.js";

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
fs.mkdirSync(path.join(source, "runtime"), { recursive: true });
const root = fs.mkdtempSync(path.join(source, "runtime", "concurrent-live-"));
const home = path.join(root, "home");
fs.mkdirSync(home);
fs.writeFileSync(path.join(home, "config.toml"), 'approval_policy = "never"\n[features]\napps = false\nhooks = false\n[permissions.bridge-review]\nextends = ":read-only"\n');
const projects = ["a", "b"].map((name) => {
  const project = path.join(root, name); fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, `${name}-sentinel.txt`), `Fixture ${name}\n`);
  return project;
});
const portServer = net.createServer();
portServer.listen(0, "127.0.0.1"); await once(portServer, "listening");
const port = portServer.address().port;
await new Promise((resolve) => portServer.close(resolve));
const cli = path.join(process.env.APPDATA ?? "", "npm", "node_modules", "@openai", "codex", "bin", "codex.js");
const child = spawn(fs.existsSync(cli) ? process.execPath : "codex",
  [...(fs.existsSync(cli) ? [cli] : []), "app-server", "--listen", `ws://127.0.0.1:${port}`],
  { cwd: root, env: { ...process.env, CODEX_HOME: home }, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
let stderr = "";
child.stderr.on("data", (data) => { stderr += String(data); });
const app = new AppServerClient(`ws://127.0.0.1:${port}`);
let proxy;
const terminals = [];
let nextId = 0;
function nextMessage(socket, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off("message", onMessage); reject(new Error("Timed out waiting for live protocol message")); }, 8_000);
    const onMessage = (raw) => {
      const message = JSON.parse(String(raw));
      if (!predicate(message)) return;
      clearTimeout(timer); socket.off("message", onMessage); resolve(message);
    };
    socket.on("message", onMessage);
  });
}
async function rpc(socket, method, params) {
  const id = ++nextId;
  const reply = nextMessage(socket, (message) => message.id === id);
  socket.send(JSON.stringify({ id, method, params }));
  const response = await reply;
  assert.equal(response.error, undefined, JSON.stringify(response.error));
  return response.result;
}
try {
  child.once("error", (error) => { stderr += error.message; });
  let connected = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode !== null) throw new Error(`Live app-server exited: ${stderr}`);
    try { await app.connect(); connected = true; break; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(connected, `Live app-server did not start: ${stderr}`);
  const threads = await Promise.all(projects.map((project, index) => app.createThread(project, `Concurrent smoke ${index}`)));
  assert.notEqual(threads[0], threads[1]);
  proxy = await AppServerProxy.start(app);
  for (let index = 0; index < threads.length; index++) {
    const terminal = new WebSocket(proxy.urlFor(String(index), threads[index]));
    terminals.push(terminal); await once(terminal, "open");
    await rpc(terminal, "initialize", { clientInfo: { name: "concurrency-smoke", version: "1" } });
    await rpc(terminal, "thread/resume", { threadId: threads[index], cwd: projects[index], permissions: "bridge-review", approvalPolicy: "never" });
  }
  for (let index = 0; index < threads.length; index++) {
    const result = await rpc(terminals[index], "thread/read", { threadId: threads[index], includeTurns: false });
    assert.equal(result.thread.id, threads[index]);
    await rpc(terminals[index], "fuzzyFileSearch/sessionStart", { sessionId: "same-id", roots: [projects[index]] });
  }
  const searches = terminals.map((terminal) => nextMessage(terminal,
    (message) => message.method === "fuzzyFileSearch/sessionUpdated" && message.params.query === "sentinel" && message.params.files.length));
  await Promise.all(terminals.map((terminal) => rpc(terminal, "fuzzyFileSearch/sessionUpdate", { sessionId: "same-id", query: "sentinel" })));
  for (const [index, result] of (await Promise.all(searches)).entries()) {
    assert.equal(result.params.sessionId, "same-id");
    assert.ok(result.params.files.every((file) => JSON.stringify(file).includes(`${index ? "b" : "a"}-sentinel.txt`)));
  }
  const aClosed = once(terminals[0], "close"); terminals[0].close(); await aClosed;
  for (let attempt = 0; proxy.connected("0") && attempt < 100; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(proxy.connected("0"), false);
  assert.equal((await rpc(terminals[1], "thread/read", { threadId: threads[1], includeTurns: false })).thread.id, threads[1]);
  const bClosed = once(terminals[1], "close"); proxy.close(); await bClosed;
  await app.drainDownstreamCleanup();
  console.log("PASS: real app-server supports two paired connections, isolated searches with identical IDs, terminal exit, and proxy shutdown.");
} finally {
  for (const terminal of terminals) terminal.terminate();
  proxy?.close(); await app.drainDownstreamCleanup(); app.close();
  if (child.exitCode === null) {
    const exited = once(child, "exit"); child.kill(); await exited;
  }
  fs.writeFileSync(path.join(root, "app-server.log"), stderr, { mode: 0o600 });
  console.log(`Private smoke-test artifacts: ${root}`);
}
