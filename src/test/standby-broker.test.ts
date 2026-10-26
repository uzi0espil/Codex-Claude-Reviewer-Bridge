import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, ChildProcess } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { WebSocketServer, WebSocket } from "ws";

async function waitFor<T>(read: () => T | Promise<T>, accept: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const value = await read();
    if (accept(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for isolated broker");
}

test("isolated broker: MCP standby/resume, durable restart, quota failure, and next-prompt delivery", { timeout: 25_000 }, async (t) => {
  const source = fileURLToPath(new URL("../../", import.meta.url));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "standby-broker-"));
  fs.cpSync(path.join(source, "dist"), path.join(root, "dist"), { recursive: true });
  fs.symlinkSync(path.join(source, "node_modules"), path.join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module","version":"0.6.0"}');
  fs.writeFileSync(path.join(root, "bridge.local.json"), JSON.stringify({ projectRoot: root, defaultMode: "auto", desktopNotifications: false }));
  fs.writeFileSync(path.join(root, "driver.mjs"), 'import { main } from "./dist/broker.js"; import { AppServerClient } from "./dist/app-server.js"; await main(new AppServerClient(process.argv[2]));');
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstream, "listening");
  const address = upstream.address();
  assert.ok(address && typeof address === "object");
  const messages: any[] = [];
  let socket: WebSocket;
  let nextTurn = 0;
  let failNext = false;
  upstream.on("connection", (client) => {
    socket = client;
    client.on("message", (data) => {
      const message = JSON.parse(String(data)); messages.push(message);
      if (!message.id) return;
      let result: any = {};
      if (message.method === "thread/start" || message.method === "thread/resume") result = { thread: { id: "thread-test" } };
      if (message.method === "turn/start") {
        if (failNext) {
          failNext = false;
          client.send(JSON.stringify({ id: message.id, error: { code: -32000, message: "Capacity unavailable", data: { codexErrorInfo: "usageLimitExceeded" } } }));
          return;
        }
        const turn = `turn-${++nextTurn}`;
        result = { turn: { id: turn } };
        setImmediate(() => client.send(JSON.stringify({ method: "turn/started", params: { threadId: "thread-test", turn: { id: turn } } })));
      }
      client.send(JSON.stringify({ id: message.id, result }));
    });
  });
  let broker: ChildProcess | undefined;
  let mcp: ChildProcess | undefined;
  let endpoint: any;
  const start = async () => {
    broker = spawn(process.execPath, [path.join(root, "driver.mjs"), `ws://127.0.0.1:${address.port}`], { cwd: root, windowsHide: true, stdio: "pipe" });
    let errors = "";
    broker.stderr!.on("data", (data) => { errors += String(data); });
    endpoint = await waitFor(() => {
      if (broker!.exitCode !== null) throw new Error(errors || "Test broker exited before startup");
      try { return JSON.parse(fs.readFileSync(path.join(root, "runtime", "endpoint.json"), "utf8")); } catch { return undefined; }
    }, (value) => Boolean(value));
  };
  const call = async (route: string, body: any = {}) => {
    const response = await fetch(endpoint.url + route, { method: "POST", headers: { authorization: `Bearer ${endpoint.token}`, "content-type": "application/json" }, body: JSON.stringify({ feature: "test", ...body }) });
    return { status: response.status, value: await response.json() as any };
  };
  const status = async () => (await call("/status")).value;
  const hook = (route: string, input: any) => call(`/hook/${route}`, { input: { session_id: "claude-test", cwd: root, ...input } });
  t.after(async () => {
    mcp?.kill();
    try { await call("/shutdown"); } catch {}
    broker?.kill();
    for (const client of upstream.clients) client.terminate();
    upstream.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    fs.rmSync(root, { recursive: true, force: true });
  });
  await start();
  await call("/pair/claude", { projectRoot: root, sessionId: "claude-test" });
  await call("/mode", { mode: "auto", roundLimit: 3 });

  // Exercise the actual MCP commands used by the two user-facing skills.
  mcp = spawn(process.execPath, [path.join(root, "dist", "mcp-server.js")], { cwd: root, windowsHide: true, stdio: "pipe" });
  let text = "";
  const replies = new Map<number, any>();
  mcp.stdout!.on("data", (data) => {
    text += String(data);
    let newline;
    while ((newline = text.indexOf("\n")) >= 0) {
      const line = text.slice(0, newline); text = text.slice(newline + 1);
      try { const message = JSON.parse(line); if (message.id) replies.set(message.id, message); } catch {}
    }
  });
  let rpcId = 0;
  const rpc = async (method: string, params: any) => {
    const id = ++rpcId;
    mcp!.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return await waitFor<any>(() => replies.get(id), Boolean);
  };
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "standby-test", version: "1" } });
  mcp.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const command = async (name: string) => {
    const response = await rpc("tools/call", { name: `review_bridge_${name}`, arguments: { feature: "test" } });
    assert.equal(response.error, undefined);
    assert.equal(response.result.isError, undefined);
    return JSON.parse(response.result.content[0].text);
  };
  assert.equal((await command("standby")).activity, "standby");
  await hook("prompt", { prompt: "The chosen color must be blue." });
  assert.equal((await hook("stop", { last_assistant_message: "First handoff" })).value.kind, "allow");
  await hook("question", { tool_name: "AskUserQuestion", tool_use_id: "q", tool_input: { questions: [{ question: "Color?", header: "Color", options: [{ label: "Blue" }, { label: "Red" }] }] } });
  await hook("answer", { tool_name: "AskUserQuestion", tool_use_id: "q", tool_response: { answers: { "Color?": "Blue" } } });
  await hook("stop", { last_assistant_message: "Latest blue handoff" });
  assert.equal(nextTurn, 0);
  assert.equal((await status()).backlog.handoffs, 2);
  assert.equal((await call("/publish", { checkpointId: "stale" })).status, 409);
  assert.equal(JSON.stringify(await status()).includes("Latest blue handoff"), false);

  const exited = once(broker!, "exit"); await call("/shutdown"); await exited;
  await start();
  assert.equal((await status()).activity, "standby");
  await command("resume");
  const reviewing = await waitFor(status, (value) => Boolean(value.pending?.codexTurnId));
  assert.equal(reviewing.autoRoundLimit, 3);
  assert.equal(reviewing.pending.source, "pull-queue");
  assert.equal(nextTurn, 1);
  const injections = messages.filter((message) => message.method === "thread/inject_items");
  assert.ok(injections.some((message) => JSON.stringify(message).includes("chosen color")));
  assert.ok(injections.some((message) => JSON.stringify(message).includes("Latest blue handoff")));
  await call("/auto-decision", { checkpointId: reviewing.pending.id, decision: "revise" });
  socket!.send(JSON.stringify({ method: "item/completed", params: { turnId: reviewing.pending.codexTurnId, item: { type: "agentMessage", text: "Fix the blue value." } } }));
  socket!.send(JSON.stringify({ method: "turn/completed", params: { threadId: "thread-test", turn: { id: reviewing.pending.codexTurnId, status: "completed" } } }));
  await waitFor(status, (value) => Boolean(value.queuedClaudeContext));
  const prompt = await hook("prompt", { prompt: "Please apply the review." });
  assert.match(prompt.value.additionalContext, /Fix the blue value/);

  // A startup quota failure releases the real held HTTP Stop and retains auto.
  failNext = true;
  assert.equal((await hook("stop", { last_assistant_message: "Handoff at capacity limit" })).value.kind, "allow");
  const exhausted = await waitFor(status, (value) => value.activity === "standby");
  assert.equal(exhausted.mode, "auto"); assert.equal(exhausted.standby.reason, "usage-limit");
  assert.equal(exhausted.autoRound, 1);
  await command("resume");
  const retrying = await waitFor(status, (value) => Boolean(value.pending?.codexTurnId));
  assert.equal(nextTurn, 2);
  assert.equal(retrying.autoRound, 1);
  await command("standby");
  assert.equal((await status()).pending, undefined);
  // A late successful result from the interrupted review cannot publish.
  socket!.send(JSON.stringify({ method: "item/completed", params: { turnId: retrying.pending.codexTurnId, item: { type: "agentMessage", text: "Obsolete review" } } }));
  socket!.send(JSON.stringify({ method: "turn/completed", params: { threadId: "thread-test", turn: { id: retrying.pending.codexTurnId, status: "completed" } } }));
  assert.equal((await call("/auto-decision", { checkpointId: retrying.pending.id, decision: "pass" })).status, 409);
  assert.equal((await status()).queuedClaudeContext, undefined);
  await command("resume");
  const midTurn = await waitFor(status, (value) => Boolean(value.pending?.codexTurnId));
  socket!.send(JSON.stringify({ method: "turn/completed", params: { threadId: "thread-test", turn: {
    id: midTurn.pending.codexTurnId, status: "failed", error: { message: "Usage exhausted", codexErrorInfo: "usageLimitExceeded" }
  } } }));
  const midTurnExhausted = await waitFor(status, (value) => value.activity === "standby");
  assert.equal(midTurnExhausted.standby.reason, "usage-limit");
  assert.equal(midTurnExhausted.autoRound, 1);
  assert.equal(midTurnExhausted.pending, undefined);

  // Off cancels recovery without discarding history. Re-arming requires resume.
  await call("/mode", { mode: "off" });
  await call("/mode", { mode: "auto", roundLimit: 2 });
  assert.equal((await status()).activity, "standby");
  assert.equal((await status()).standby.nextRetryAt, undefined);
});
