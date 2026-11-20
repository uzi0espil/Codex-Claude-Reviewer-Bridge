import assert from "node:assert/strict";
import { once } from "node:events";
import net from "node:net";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { AppServerClient, CompletedTurn, StartedTurn } from "../app-server.js";
import { AppServerProxy } from "../app-server-proxy.js";

test("the reviewer proxy multiplexes broker and TUI traffic over one upstream connection", async (t) => {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstream, "listening");
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("Fake app-server did not bind to a TCP port.");

  let upstreamConnections = 0;
  const upstreamMessages: any[] = [];
  let upstreamSocket: WebSocket | undefined;
  let resolveApprovalResponse: ((message: any) => void) | undefined;
  const approvalAtUpstream = new Promise<any>((resolve) => { resolveApprovalResponse = resolve; });
  upstream.on("connection", (socket) => {
    upstreamConnections++;
    upstreamSocket = socket;
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString());
      upstreamMessages.push(message);
      if (message.id === "approval-upstream" && !message.method) resolveApprovalResponse!(message);
      if (message.method === "initialize") {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { serverInfo: { name: "fake" } } }));
      } else if (message.method === "thread/start") {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { thread: { id: "thread-created" } } }));
      } else if (message.method === "thread/name/set") {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
      } else if (message.method === "thread/resume") {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { thread: { id: "thread-1" } } }));
      } else if (message.method === "turn/start") {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { turn: { id: "turn-1" } } }));
      }
    });
  });

  const app = new AppServerClient(`ws://127.0.0.1:${address.port}`);
  await app.connect();
  const proxy = await AppServerProxy.start(app);
  const reviewer = new WebSocket(proxy.url);
  await once(reviewer, "open");

  t.after(() => {
    reviewer.close();
    proxy.close();
    app.close();
    upstream.close();
  });

  reviewer.send(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "initialize", params: { clientInfo: { name: "codex-tui" } } }));
  const initialized = await nextJson(reviewer, (message) => message.id === 7);
  assert.deepEqual(initialized.result, { serverInfo: { name: "fake" } });
  assert.equal(upstreamMessages.filter((message) => message.method === "initialize").length, 1);
  assert.equal(upstreamConnections, 1);

  assert.equal(await app.createThread("C:/project", "Created thread"), "thread-created");
  const bridgeStart = upstreamMessages.find((message) => message.method === "thread/start");
  assert.equal(bridgeStart.params.permissions, "bridge-review");
  assert.equal("sandbox" in bridgeStart.params, false);

  await app.resumeThread("thread-1", "C:/project");
  const bridgeResume = upstreamMessages.find((message) => message.method === "thread/resume");
  assert.equal(bridgeResume.params.permissions, "bridge-review");
  assert.equal("sandbox" in bridgeResume.params, false);

  reviewer.send(JSON.stringify({ jsonrpc: "2.0", id: "resume-from-tui", method: "thread/resume", params: { threadId: "thread-1" } }));
  const resumed = await nextJson(reviewer, (message) => message.id === "resume-from-tui");
  assert.equal(resumed.result.thread.id, "thread-1");
  const upstreamResume = upstreamMessages.find((message) => message.method === "thread/resume" && !("permissions" in message.params));
  assert.equal(typeof upstreamResume.id, "number");
  assert.notEqual(upstreamResume.id, "resume-from-tui");

  const completedPromise = once(app, "turnCompleted") as Promise<[CompletedTurn]>;
  const startedPromise = once(app, "turnStarted") as Promise<[StartedTurn]>;
  const compactedPromise = once(app, "contextCompacted") as Promise<[string]>;
  const started = nextJson(reviewer, (message) => message.method === "turn/started");
  const itemCompleted = nextJson(reviewer, (message) => message.method === "item/completed" && message.params?.item?.type === "agentMessage");
  const turnCompleted = nextJson(reviewer, (message) => message.method === "turn/completed");
  assert.equal(await app.startReview("thread-1", "C:/project", "Review this"), "turn-1");
  assert.equal(await app.startQuestionAdvisory("thread-1", "C:/project", "Advise on this"), "turn-1");
  const bridgeTurns = upstreamMessages.filter((message) => message.method === "turn/start");
  assert.equal(bridgeTurns.length, 2);
  for (const bridgeTurn of bridgeTurns) {
    assert.equal(bridgeTurn.params.permissions, "bridge-review");
    assert.equal(bridgeTurn.params.approvalPolicy, "never");
    assert.equal("sandboxPolicy" in bridgeTurn.params, false);
  }
  upstreamSocket!.send(JSON.stringify({ jsonrpc: "2.0", method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1" } } }));
  upstreamSocket!.send(JSON.stringify({ jsonrpc: "2.0", method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { type: "contextCompaction", id: "compact-1" } } }));
  upstreamSocket!.send(JSON.stringify({ jsonrpc: "2.0", method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { type: "agentMessage", text: "No findings." } } }));
  upstreamSocket!.send(JSON.stringify({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } }));

  assert.equal((await started).params.turn.id, "turn-1");
  assert.deepEqual((await startedPromise)[0], { threadId: "thread-1", turnId: "turn-1" });
  assert.equal((await itemCompleted).params.item.text, "No findings.");
  assert.equal((await turnCompleted).params.turn.status, "completed");
  assert.equal((await compactedPromise)[0], "thread-1");
  assert.deepEqual((await completedPromise)[0], {
    threadId: "thread-1",
    turnId: "turn-1",
    text: "No findings.",
    status: "completed",
    error: undefined
  });

  const approvalAtReviewer = nextJson(reviewer, (message) => message.method === "item/commandExecution/requestApproval");
  upstreamSocket!.send(JSON.stringify({ jsonrpc: "2.0", id: "approval-upstream", method: "item/commandExecution/requestApproval", params: { reason: "test" } }));
  const approval = await approvalAtReviewer;
  assert.equal(typeof approval.id, "number");
  assert.ok(approval.id < 0);
  reviewer.send(JSON.stringify({ jsonrpc: "2.0", id: approval.id, result: { decision: "decline" } }));
  assert.deepEqual(await approvalAtUpstream, { jsonrpc: "2.0", id: "approval-upstream", result: { decision: "decline" } });
  assert.equal(upstreamConnections, 1);
});

function nextJson(socket: WebSocket, predicate: (message: any) => boolean): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { socket.off("message", listener); reject(new Error("Timed out waiting for protocol message")); }, 3_000);
    const listener = (data: WebSocket.RawData): void => {
      const message = JSON.parse(data.toString());
      if (!predicate(message)) return;
      clearTimeout(timeout);
      socket.off("message", listener);
      resolve(message);
    };
    socket.on("message", listener);
  });
}

test("feature terminals isolate traffic and clean up exits, reconnects, and shutdown", { timeout: 15_000 }, async (t) => {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstream, "listening");
  const address = upstream.address();
  assert.ok(address && typeof address === "object");
  const messages: any[] = [];
  let source!: WebSocket;
  upstream.on("connection", (socket) => {
    source = socket;
    socket.on("message", (data) => {
      const message = JSON.parse(String(data));
      messages.push(message);
      if (!message.method || message.id === undefined || message.method === "test/held") return;
      socket.send(JSON.stringify({ id: message.id, result: { method: message.method, params: message.params } }));
    });
  });
  const app = new AppServerClient(`ws://127.0.0.1:${address.port}`);
  await app.connect();
  const proxy = await AppServerProxy.start(app);
  const clients: WebSocket[] = [];
  t.after(async () => {
    for (const client of clients) client.terminate();
    proxy.close();
    app.close();
    for (const client of upstream.clients) client.terminate();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });
  const urlA = proxy.urlFor("a", "thread-a");
  const urlB = proxy.urlFor("b", "thread-b");
  assert.notEqual(urlA, urlB);
  assert.equal(proxy.urlFor("a", "thread-a"), urlA);
  const open = async (url: string) => {
    const client = new WebSocket(url); clients.push(client);
    await once(client, "open");
    return client;
  };
  const a = await open(urlA);
  const b = await open(urlB);
  const seenA: any[] = [], seenB: any[] = [];
  a.on("message", (data) => seenA.push(JSON.parse(String(data))));
  b.on("message", (data) => seenB.push(JSON.parse(String(data))));
  let id = 0;
  const rpc = async (client: WebSocket, method: string, params: any = {}) => {
    const requestId = `rpc-${++id}`;
    const response = nextJson(client, (message) => message.id === requestId);
    client.send(JSON.stringify({ id: requestId, method, params }));
    return await response;
  };
  // Both TUIs may use the same JSON-RPC IDs. Broker RPCs share the upstream too.
  const responseA = nextJson(a, (message) => message.id === 7);
  const responseB = nextJson(b, (message) => message.id === 7);
  a.send(JSON.stringify({ id: 7, method: "thread/read", params: { threadId: "thread-a" } }));
  b.send(JSON.stringify({ id: 7, method: "thread/read", params: { threadId: "thread-b" } }));
  const [replyA, replyB] = await Promise.all([responseA, responseB, app.readRateLimits()]);
  assert.equal(replyA.result.params.threadId, "thread-a");
  assert.equal(replyB.result.params.threadId, "thread-b");
  assert.ok(proxy.connected("a") && proxy.connected("b"));
  const complete = once(app, "turnCompleted");
  source.send(JSON.stringify({ method: "item/completed", params: { threadId: "thread-a", turnId: "turn-a", item: { type: "agentMessage", text: "Only A" } } }));
  source.send(JSON.stringify({ method: "turn/completed", params: { threadId: "thread-a", turn: { id: "turn-a", status: "completed" } } }));
  source.send(JSON.stringify({ method: "thread/started", params: { thread: { id: "thread-b" } } }));
  source.send(JSON.stringify({ method: "account/rateLimits/updated", params: { rateLimits: {} } }));
  source.send(JSON.stringify({ method: "unknown/privateEvent", params: { text: "Unscoped thread content" } }));
  await Promise.all([rpc(a, "account/read"), rpc(b, "account/read")]);
  assert.equal((await complete)[0].text, "Only A");
  assert.equal(seenA.filter((message) => message.method === "turn/completed").length, 1);
  assert.equal(seenB.filter((message) => message.method === "turn/completed").length, 0);
  assert.equal(seenA.filter((message) => message.method === "thread/started").length, 0);
  assert.equal(seenB.filter((message) => message.method === "thread/started").length, 1);
  for (const seen of [seenA, seenB]) {
    assert.ok(seen.some((message) => message.method === "account/rateLimits/updated"));
    assert.equal(seen.some((message) => message.method === "unknown/privateEvent"), false);
  }
  const crossThread = await rpc(a, "thread/resume", { threadId: "thread-b" });
  assert.equal(crossThread.error.code, -32602);
  assert.equal((await rpc(a, "thread/start")).error.code, -32602);
  assert.equal(messages.some((message) => message.method === "thread/resume"), false);

  const approvalA = nextJson(a, (message) => message.method === "item/commandExecution/requestApproval");
  const approvalB = nextJson(b, (message) => message.method === "item/tool/requestUserInput");
  source.send(JSON.stringify({ id: "approval-a", method: "item/commandExecution/requestApproval", params: { threadId: "thread-a" } }));
  source.send(JSON.stringify({ id: "approval-b", method: "item/tool/requestUserInput", params: { threadId: "thread-b" } }));
  const [requestA, requestB] = await Promise.all([approvalA, approvalB]);
  // A different terminal cannot answer or consume A's pending approval.
  b.send(JSON.stringify({ id: requestA.id, result: { decision: "accept" } }));
  await rpc(b, "account/read");
  assert.equal(messages.some((message) => message.id === "approval-a"), false);
  b.send(JSON.stringify({ id: requestB.id, result: { answers: {} } }));
  await rpc(b, "account/read");
  assert.ok(messages.some((message) => message.id === "approval-b" && message.result));

  // An unscoped interactive request must never be sent to an arbitrary pair.
  source.send(JSON.stringify({ id: "unscoped", method: "item/tool/requestUserInput", params: {} }));
  await rpc(a, "account/read");
  assert.ok(messages.some((message) => message.id === "unscoped" && message.error));
  a.send(JSON.stringify({ id: "held-old", method: "test/held" }));
  await rpc(a, "account/read");
  const heldOld = messages.find((message) => message.method === "test/held");
  const closedA = once(a, "close");
  const replacement = await open(urlA);
  const [code] = await closedA;
  assert.equal(code, 1012);
  assert.equal(b.readyState, WebSocket.OPEN);
  await rpc(replacement, "account/read");
  assert.ok(messages.some((message) => message.id === "approval-a" && /disconnected/.test(message.error?.message)));
  const replacementMessages: any[] = [];
  replacement.on("message", (data) => replacementMessages.push(JSON.parse(String(data))));
  source.send(JSON.stringify({ id: heldOld.id, result: { stale: true } }));
  replacement.send(JSON.stringify({ id: requestA.id, result: { decision: "accept" } }));
  await rpc(replacement, "account/read");
  assert.equal(replacementMessages.some((message) => message.id === "held-old"), false);
  assert.equal(messages.filter((message) => message.id === "approval-a").length, 1);

  // Searches, watches, and processes are scoped to the physical upstream
  // connection by Codex, so identical IDs from separate TUIs need remapping.
  for (const client of [replacement, b]) {
    await rpc(client, "fuzzyFileSearch/sessionStart", { sessionId: "search", roots: [] });
    await rpc(client, "fs/watch", { watchId: "watch", path: "C:/project" });
    await rpc(client, "process/spawn", { processHandle: "process", command: ["fixture"] });
    await rpc(client, "mcpServer/event/stream/start", { subscriptionId: "events" });
  }
  const searches = messages.filter((message) => message.method === "fuzzyFileSearch/sessionStart");
  assert.notEqual(searches[0].params.sessionId, searches[1].params.sessionId);
  const watched = messages.filter((message) => message.method === "fs/watch");
  const processes = messages.filter((message) => message.method === "process/spawn");
  const subscriptions = messages.filter((message) => message.method === "mcpServer/event/stream/start");
  const ownSearch = nextJson(replacement, (message) => message.method === "fuzzyFileSearch/sessionUpdated");
  const ownOutput = nextJson(b, (message) => message.method === "process/outputDelta");
  source.send(JSON.stringify({ method: "fuzzyFileSearch/sessionUpdated", params: { sessionId: searches[0].params.sessionId, query: "A" } }));
  source.send(JSON.stringify({ method: "process/outputDelta", params: { processHandle: processes[1].params.processHandle, deltaBase64: "Qg==" } }));
  assert.equal((await ownSearch).params.sessionId, "search");
  assert.equal((await ownOutput).params.processHandle, "process");
  await rpc(b, "account/read");
  assert.equal(seenB.some((message) => message.method === "fuzzyFileSearch/sessionUpdated"), false);
  assert.equal(replacementMessages.some((message) => message.method === "process/outputDelta"), false);
  await rpc(replacement, "fuzzyFileSearch/sessionStop", { sessionId: "search" });
  assert.equal((await rpc(replacement, "fuzzyFileSearch/sessionUpdate", { sessionId: "search", query: "late" })).error.code, -32602);

  // Server-initiated resolution also uses the TUI's remapped request ID.
  const resolvedApproval = nextJson(b, (message) => message.method === "item/tool/requestUserInput");
  source.send(JSON.stringify({ id: "resolved-b", method: "item/tool/requestUserInput", params: { threadId: "thread-b" } }));
  const resolvedRequest = await resolvedApproval;
  const resolvedNotice = nextJson(b, (message) => message.method === "serverRequest/resolved");
  source.send(JSON.stringify({ method: "serverRequest/resolved", params: { threadId: "thread-b", requestId: "resolved-b" } }));
  assert.equal((await resolvedNotice).params.requestId, resolvedRequest.id);

  // Exiting B clears its connection and pending server requests immediately.
  const exitApproval = nextJson(b, (message) => message.method === "item/tool/requestUserInput");
  source.send(JSON.stringify({ id: "exit-b", method: "item/tool/requestUserInput", params: { threadId: "thread-b" } }));
  await exitApproval;
  const closedB = once(b, "close"); b.close(); await closedB;
  await rpc(replacement, "account/read");
  assert.equal(proxy.connected("b"), false);
  assert.ok(proxy.connected("a"));
  assert.ok(messages.some((message) => message.id === "exit-b" && message.error));
  assert.equal(messages.some((message) => message.id === "resolved-b"), false);
  for (const [method, field, resource] of [
    ["fs/unwatch", "watchId", watched[1].params.watchId],
    ["fuzzyFileSearch/sessionStop", "sessionId", searches[1].params.sessionId],
    ["process/kill", "processHandle", processes[1].params.processHandle],
    ["mcpServer/event/stream/stop", "subscriptionId", subscriptions[1].params.subscriptionId]
  ]) assert.ok(messages.some((message) => message.method === method && message.params[field] === resource));
  assert.equal(messages.some((message) => message.method === "fs/unwatch" && message.params.watchId === watched[0].params.watchId), false);
  // A fresh B can reconnect after its earlier terminal exited.
  const restartedB = await open(urlB);
  await rpc(restartedB, "thread/resume", { threadId: "thread-b" });
  const obsoleteClosed = once(replacement, "close");
  const newUrlA = proxy.urlFor("a", "thread-a2");
  assert.equal((await obsoleteClosed)[0], 1012);
  assert.notEqual(newUrlA, urlA);
  const obsolete = await open(urlA);
  assert.equal((await once(obsolete, "close"))[0], 1008);
  const newA = await open(newUrlA);
  await rpc(newA, "thread/resume", { threadId: "thread-a2" });
  assert.equal(restartedB.readyState, WebSocket.OPEN);
  const shutdownA = once(newA, "close"), shutdownB = once(restartedB, "close");
  proxy.close(); proxy.close();
  assert.equal(proxy.connected("a"), false);
  assert.equal(proxy.connected("b"), false);
  assert.equal((await shutdownA)[0], 1001);
  assert.equal((await shutdownB)[0], 1001);
});

test("shutdown bounds cleanup when a terminal ignores the close handshake", { timeout: 5_000 }, async (t) => {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstream, "listening");
  const address = upstream.address();
  assert.ok(address && typeof address === "object");
  upstream.on("connection", (socket) => socket.on("message", (data) => {
    const message = JSON.parse(String(data));
    if (message.id !== undefined) socket.send(JSON.stringify({ id: message.id, result: {} }));
  }));
  const app = new AppServerClient(`ws://127.0.0.1:${address.port}`);
  await app.connect();
  const proxy = await AppServerProxy.start(app);
  const url = new URL(proxy.urlFor("stubborn", "thread"));
  const peer = net.connect(Number(url.port), url.hostname);
  peer.on("error", () => undefined);
  t.after(() => {
    peer.destroy(); proxy.close(); app.close();
    for (const client of upstream.clients) client.terminate();
    upstream.close();
  });
  await once(peer, "connect");
  const handshake = once(peer, "data");
  peer.write(`GET ${url.pathname} HTTP/1.1\r\nHost: ${url.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: MDEyMzQ1Njc4OWFiY2RlZg==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  assert.match(String((await handshake)[0]), /101 Switching Protocols/);
  assert.equal(proxy.connected("stubborn"), true);
  // Drain frames without implementing a WebSocket close response.
  peer.on("data", () => undefined);
  const closed = once(peer, "close");
  proxy.close();
  assert.equal(proxy.connected("stubborn"), false);
  await closed;
  await assert.rejects(new Promise<void>((resolve, reject) => {
    const reconnect = net.connect(Number(url.port), url.hostname);
    reconnect.once("connect", () => { reconnect.destroy(); resolve(); });
    reconnect.once("error", reject);
  }), /ECONNREFUSED/);
});

test("unresponsive terminals and upstream exit release proxy connections", { timeout: 5_000 }, async (t) => {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstream, "listening");
  const address = upstream.address();
  assert.ok(address && typeof address === "object");
  upstream.on("connection", (socket) => socket.on("message", (data) => {
    const message = JSON.parse(String(data));
    if (message.id !== undefined) socket.send(JSON.stringify({ id: message.id, result: {} }));
  }));
  const app = new AppServerClient(`ws://127.0.0.1:${address.port}`);
  await app.connect();
  const proxy = await AppServerProxy.start(app, 100);
  const dead = new WebSocket(proxy.urlFor("dead", "dead-thread"), { autoPong: false });
  const live = new WebSocket(proxy.urlFor("live", "live-thread"));
  t.after(() => {
    dead.terminate(); live.terminate(); proxy.close(); app.close();
    for (const client of upstream.clients) client.terminate();
    upstream.close();
  });
  await Promise.all([once(dead, "open"), once(live, "open")]);
  await once(dead, "close");
  assert.equal(proxy.connected("dead"), false);
  assert.equal(live.readyState, WebSocket.OPEN);
  const liveClosed = once(live, "close");
  for (const client of upstream.clients) client.terminate();
  await liveClosed;
  assert.equal(proxy.connected("live"), false);
});
