import assert from "node:assert/strict";
import { once } from "node:events";
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

  reviewer.send(JSON.stringify({ jsonrpc: "2.0", id: "resume-from-tui", method: "thread/resume", params: { threadId: "thread-1" } }));
  const resumed = await nextJson(reviewer, (message) => message.id === "resume-from-tui");
  assert.equal(resumed.result.thread.id, "thread-1");
  const upstreamResume = upstreamMessages.find((message) => message.method === "thread/resume");
  assert.equal(typeof upstreamResume.id, "number");
  assert.notEqual(upstreamResume.id, "resume-from-tui");

  const completedPromise = once(app, "turnCompleted") as Promise<[CompletedTurn]>;
  const startedPromise = once(app, "turnStarted") as Promise<[StartedTurn]>;
  const compactedPromise = once(app, "contextCompacted") as Promise<[string]>;
  const started = nextJson(reviewer, (message) => message.method === "turn/started");
  const itemCompleted = nextJson(reviewer, (message) => message.method === "item/completed" && message.params?.item?.type === "agentMessage");
  const turnCompleted = nextJson(reviewer, (message) => message.method === "turn/completed");
  assert.equal(await app.startReview("thread-1", "C:/project", "Review this"), "turn-1");
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
  return new Promise((resolve) => {
    const listener = (data: WebSocket.RawData): void => {
      const message = JSON.parse(data.toString());
      if (!predicate(message)) return;
      socket.off("message", listener);
      resolve(message);
    };
    socket.on("message", listener);
  });
}
