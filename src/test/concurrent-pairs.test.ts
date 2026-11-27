import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { promisify } from "node:util";
import test from "node:test";
import { WebSocketServer, WebSocket } from "ws";

async function waitFor<T>(read: () => T | Promise<T>, accept: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 300; attempt++) {
    const value = await read();
    if (accept(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for concurrent pair state");
}

test("one broker isolates simultaneous pair checkpoints and terminal exits", { timeout: 15_000 }, async (t) => {
  const source = fileURLToPath(new URL("../../", import.meta.url));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "concurrent-pairs-"));
  fs.cpSync(path.join(source, "dist"), path.join(root, "dist"), { recursive: true });
  fs.mkdirSync(path.join(root, "scripts"));
  fs.copyFileSync(path.join(source, "scripts", "reviewer.mjs"), path.join(root, "scripts", "reviewer.mjs"));
  fs.symlinkSync(path.join(source, "node_modules"), path.join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module","version":"0.7.0"}');
  fs.writeFileSync(path.join(root, "bridge.local.json"), JSON.stringify({ projectRoot: root, desktopNotifications: false }));
  fs.writeFileSync(path.join(root, "driver.mjs"), 'import { main } from "./dist/broker.js"; import { AppServerClient } from "./dist/app-server.js"; await main(new AppServerClient(process.argv[2]));');
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstream, "listening");
  const address = upstream.address();
  assert.ok(address && typeof address === "object");
  let nextThread = 0, nextTurn = 0;
  let cleanupAcknowledged = false;
  let upstreamSocket!: WebSocket;
  upstream.on("connection", (socket) => {
    upstreamSocket = socket;
    socket.on("message", (data) => {
      const message = JSON.parse(String(data));
      if (message.id === undefined || !message.method) return;
      if (message.method === "fs/unwatch") {
        setTimeout(() => {
          cleanupAcknowledged = true;
          socket.send(JSON.stringify({ id: message.id, result: {} }));
        }, 80);
        return;
      }
      let result: any = {};
      if (message.method === "thread/start") result = { thread: { id: `thread-${++nextThread}` } };
      if (message.method === "thread/resume") result = { thread: { id: message.params.threadId } };
      if (message.method === "turn/start") {
        result = { turn: { id: `turn-${++nextTurn}` } };
        socket.send(JSON.stringify({ method: "turn/started", params: { threadId: message.params.threadId, turn: result.turn } }));
      }
      socket.send(JSON.stringify({ id: message.id, result }));
    });
  });
  const startBroker = () => spawn(process.execPath, [path.join(root, "driver.mjs"), `ws://127.0.0.1:${address.port}`], {
    cwd: root, windowsHide: true, stdio: "pipe"
  });
  let broker = startBroker();
  let errors = "";
  broker.stderr!.on("data", (data) => { errors += String(data); });
  let endpoint: any;
  const terminals: WebSocket[] = [];
  const call = async (route: string, body: any = {}) => {
    const response = await fetch(endpoint.url + route, { method: "POST", headers: { authorization: `Bearer ${endpoint.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    const value = await response.json() as any;
    assert.equal(response.status, 200, JSON.stringify(value));
    return value;
  };
  t.after(async () => {
    for (const terminal of terminals) terminal.terminate();
    if (broker.exitCode === null) {
      const exited = once(broker, "exit");
      try { await call("/shutdown"); } catch { broker.kill(); }
      await exited;
    }
    for (const socket of upstream.clients) socket.terminate();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  endpoint = await waitFor(() => {
    if (broker.exitCode !== null) throw new Error(errors || "Broker exited before startup");
    try { return JSON.parse(fs.readFileSync(path.join(root, "runtime", "endpoint.json"), "utf8")); } catch { return undefined; }
  }, Boolean);
  const [a, b] = await Promise.all(["a", "b"].map(async (feature) => {
    await call("/pair/claude", { feature, projectRoot: root, sessionId: `claude-${feature}` });
    return await call("/pair/codex", { feature, projectRoot: root });
  }));
  assert.notEqual(a.codexThreadId, b.codexThreadId);
  assert.notEqual(a.appServerUrl, b.appServerUrl);
  for (const pair of [a, b]) {
    const terminal = new WebSocket(pair.appServerUrl); terminals.push(terminal);
    await once(terminal, "open");
  }
  assert.ok((await call("/pairs")).every((pair: any) => pair.reviewerConnected));
  const launch = (feature: string) => {
    const generation = randomUUID();
    const hash = createHash("sha256").update(feature).digest("hex");
    const directory = path.join(root, "runtime", "launches", `${hash}-claude.lock`);
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, "owner.json");
    fs.writeFileSync(file, JSON.stringify({ generation, pid: process.pid, createdAt: new Date().toISOString() }));
    return file;
  };
  const ownerA = launch("a");
  const ownerB = launch("b");
  const hook = promisify(execFile)(process.execPath, [path.join(root, "dist", "claude-hook.js"), "session"], {
    cwd: root, timeout: 5000, env: {
      ...process.env, REVIEW_BRIDGE_FEATURE: "a",
      REVIEW_BRIDGE_LAUNCH_GENERATION: JSON.parse(fs.readFileSync(ownerA, "utf8")).generation
    }
  });
  hook.child.stdin!.end(JSON.stringify({ session_id: a.claudeSessionId, cwd: root, hook_event_name: "SessionStart" }));
  const hookOutput = JSON.parse((await hook).stdout);
  assert.equal(hookOutput.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(hookOutput.hookSpecificOutput.additionalContext, /lock run <name>/);
  const cli = (...args: string[]) => promisify(execFile)(process.execPath, [
    path.join(root, "scripts", "reviewer.mjs"), ...args
  ], { cwd: root, timeout: 5000 });
  const marker = path.join(root, "workload-started");
  const managedResult = cli("lock", "run", "machine-load", "--feature", "b", "--mode", "shared", "--",
    process.execPath, "-e", "require('fs').writeFileSync(process.argv[1], 'running'); setTimeout(() => {}, 4000);", marker)
    .then((value) => ({ value }), (error: Error) => ({ error }));
  await waitFor(() => fs.existsSync(marker), Boolean);
  const waitForExclusive = cli("lock", "acquire", "machine-load", "--feature", "a", "--mode", "exclusive", "--wait", "--json");
  fs.unlinkSync(ownerB);
  const stoppedWork = await managedResult;
  assert.ok("error" in stoppedWork);
  assert.match(stoppedWork.error.message, /owner exited|cleanup is required/);
  const held = JSON.parse((await waitForExclusive).stdout);
  assert.match((await cli("pairs")).stdout, /machine-load a exclusive age=\d+s ttl=30m/);
  assert.deepEqual((await call("/lock/status")).leases, [held]);
  const leaseCursor = (await call("/watch", { feature: "a" })).cursor;
  const handoff = (pair: any) => call("/hook/stop", { feature: pair.feature, input: { session_id: pair.claudeSessionId, cwd: root, last_assistant_message: `Handoff ${pair.feature}` } });
  let resolvedB = false;
  const stopA = handoff(a), stopB = handoff(b).then((result) => { resolvedB = true; return result; });
  const state = async (feature: string) => await call("/status", { feature });
  const [reviewA, reviewB] = await Promise.all([a, b].map((pair) => waitFor(() => state(pair.feature), (value) => Boolean(value.pending?.codexTurnId))));
  assert.deepEqual(reviewA.pending.leaseEvidence.active, [held]);
  assert.equal(reviewA.pending.leaseEvidence.history.at(-1).type, "lease-granted");
  for (const pair of [reviewA, reviewB]) {
    upstreamSocket.send(JSON.stringify({ method: "item/completed", params: { threadId: pair.codexThreadId, turnId: pair.pending.codexTurnId, item: { type: "agentMessage", text: `Review ${pair.feature}` } } }));
    upstreamSocket.send(JSON.stringify({ method: "turn/completed", params: { threadId: pair.codexThreadId, turn: { id: pair.pending.codexTurnId, status: "completed" } } }));
  }
  await Promise.all([a, b].map((pair) => waitFor(() => state(pair.feature), (value) => value.status === "waiting-user")));
  await call("/publish", { feature: "a", checkpointId: reviewA.pending.id });
  assert.match((await stopA).text, /Review a/);
  assert.equal(resolvedB, false);
  assert.equal((await state("b")).pending.id, reviewB.pending.id);
  const closedA = once(terminals[0], "close"); terminals[0].close(); await closedA;
  await waitFor(() => state("a"), (value) => !value.reviewerConnected);
  assert.equal((await state("b")).reviewerConnected, true);
  await call("/publish", { feature: "b", checkpointId: reviewB.pending.id });
  assert.match((await stopB).text, /Review b/);
  const reportA = await call("/report", { feature: "a", full: true });
  const reportB = await call("/report", { feature: "b", full: true });
  assert.match(reportA.report, /Handoff a/);
  assert.doesNotMatch(reportA.report, /Handoff b/);
  assert.match(reportB.report, /Handoff b/);
  assert.doesNotMatch(reportB.report, /Handoff a/);
  const watched = once(terminals[1], "message");
  terminals[1].send(JSON.stringify({ id: "watch", method: "fs/watch", params: { watchId: "watch", path: root } }));
  assert.equal(JSON.parse(String((await watched)[0])).id, "watch");
  const running = path.join(root, "restart-workload-started");
  const finish = path.join(root, "restart-workload-finish");
  const restartingWork = cli("lock", "run", "restart-test", "--feature", "a", "--mode", "exclusive", "--",
    process.execPath, "-e", [
      "const fs = require('fs'); fs.writeFileSync(process.argv[1], 'started');",
      "const poll = setInterval(() => { if (fs.existsSync(process.argv[2])) { clearInterval(poll); console.log('finished'); } }, 30);",
      "setTimeout(() => process.exit(2), 4000).unref();"
    ].join(" "), running, finish).then((value) => ({ value }), (error: Error) => ({ error }));
  await waitFor(() => fs.existsSync(running), Boolean);
  const beforeRestart = (await call("/lock/status")).leases;
  const closedB = once(terminals[1], "close"), exited = once(broker, "exit");
  await call("/shutdown"); await Promise.all([closedB, exited]);
  assert.equal(cleanupAcknowledged, true, "Broker must drain cleanup before closing the app-server transport");
  assert.equal(fs.existsSync(path.join(root, "runtime", "endpoint.json")), false);
  broker = startBroker();
  broker.stderr!.on("data", (data) => { errors += String(data); });
  endpoint = await waitFor(() => {
    if (broker.exitCode !== null) throw new Error(errors || "Test broker exited during restart");
    try { return JSON.parse(fs.readFileSync(path.join(root, "runtime", "endpoint.json"), "utf8")); } catch { return undefined; }
  }, Boolean);
  const restored = (await call("/lock/status")).leases;
  assert.deepEqual(restored.toSorted((a: any, b: any) => a.name.localeCompare(b.name)),
    beforeRestart.toSorted((a: any, b: any) => a.name.localeCompare(b.name)));
  fs.writeFileSync(finish, "");
  const finishedWork = await restartingWork;
  if ("error" in finishedWork) throw finishedWork.error;
  assert.match(finishedWork.value.stdout, /finished/);
  assert.deepEqual((await call("/lock/status")).leases, [held]);
  const events = (await call("/watch", { feature: "a", after: leaseCursor })).events;
  assert.equal(events.find((event: any) => event.type === "lease-restored").lease.id, held.id);
  fs.unlinkSync(ownerA);
  assert.deepEqual((await call("/lock/status")).leases, []);
});
