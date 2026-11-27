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

test("isolated broker: MCP standby/resume, durable restart, quota failure, and off-mode pull delivery", { timeout: 25_000 }, async (t) => {
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
    broker = spawn(process.execPath, [path.join(root, "driver.mjs"), `ws://127.0.0.1:${address.port}`], {
      cwd: root, windowsHide: true, stdio: "pipe",
      env: { ...process.env, CLAUDE_CONFIG_DIR: path.join(root, "claude-config") }
    });
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
  // The broker must repair a reserved session after hooks were unavailable,
  // without mistaking promptless startup metadata for conversation history.
  const recoveryPair = { feature: "recovery", projectRoot: root, sessionId: "recover-session" };
  assert.equal((await call("/pair/claude", recoveryPair)).value.claudeSessionStarted, false);
  const project = path.join(root, "claude-config", "projects", root.replace(/[^a-zA-Z0-9]/g, "-"));
  fs.mkdirSync(project, { recursive: true });
  const transcript = path.join(project, "recover-session.jsonl");
  fs.writeFileSync(transcript, JSON.stringify({ type: "file-history-snapshot", sessionId: "recover-session" }) + "\n");
  assert.equal((await call("/pair/claude", recoveryPair)).value.claudeSessionStarted, false);
  fs.appendFileSync(transcript, JSON.stringify({ type: "user", sessionId: "recover-session", message: { role: "user", content: "A prompt while the bridge was down" } }) + "\n");
  assert.equal((await call("/pair/claude", recoveryPair)).value.claudeSessionStarted, true);
  fs.rmSync(transcript);
  assert.equal((await call("/pair/claude", recoveryPair)).value.claudeSessionStarted, true);
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
  const command = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await rpc("tools/call", { name: `review_bridge_${name}`, arguments: { feature: "test", ...args } });
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
  const launchToken = "ab".repeat(32);
  const binding = { launchToken, sessionId: "claude-test" };
  assert.equal((await call("/pair/claude", { projectRoot: root, channelToken: launchToken })).value.autoDeliveryEnabled, true);
  assert.equal((await call("/channel/claim", { ...binding, sessionId: "other-session" })).status, 403);
  assert.equal((await call("/channel/claim", { ...binding, launchToken: "cd".repeat(32) })).status, 403);
  assert.deepEqual((await call("/channel/claim", binding)).value, {});
  await hook("session", {});
  const claim = (await call("/channel/claim", binding)).value;
  assert.equal(claim.checkpointId, reviewing.pending.id);
  assert.match(claim.feedback, /Fix the blue value/);
  assert.ok(claim.receiptId);
  assert.deepEqual((await call("/channel/claim", binding)).value, {});
  assert.equal((await hook("prompt", { prompt: "A prompt racing a channel send." })).value.additionalContext, undefined);
  assert.equal((await status()).autoDeliveryAwaitingReceipt, true);
  assert.equal((await call("/pair/review-options", { delivery: "next-prompt" })).value.autoDeliveryAwaitingReceipt, false);
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

  // Explicit pulls review and queue feedback without ever arming interception.
  await call("/mode", { mode: "off" });
  assert.equal((await call("/pull-queue")).status, 409); // No off-mode capture yet.
  assert.equal((await hook("stop", { last_assistant_message: "Off-mode handoff" })).value.kind, "allow");
  const pulled = await command("pull_queue");
  assert.equal(pulled.mode, "off");
  assert.equal(pulled.delivery, "next-prompt-if-feedback");
  const offReview = await waitFor(status, (value) => Boolean(value.pending?.codexTurnId));
  assert.equal(offReview.mode, "off");
  assert.equal(offReview.pending.source, "pull-queue");
  assert.equal((await call("/pull-queue")).status, 409); // Duplicate capture.
  assert.equal((await call("/publish", { checkpointId: pulled.checkpointId })).status, 409); // Still reviewing.
  assert.equal((await hook("stop", { last_assistant_message: "New capture during review" })).value.kind, "allow");
  assert.equal((await status()).status, "reviewing");
  assert.match((await call("/pull-queue")).value.error, /checkpoint is already pending/);
  const finish = (turnId: string, review: string) => {
    socket!.send(JSON.stringify({ method: "item/completed", params: { turnId, item: { type: "agentMessage", text: review } } }));
    socket!.send(JSON.stringify({ method: "turn/completed", params: { threadId: "thread-test", turn: { id: turnId, status: "completed" } } }));
  };
  finish(offReview.pending.codexTurnId, "Fix the off-mode issue.");
  const ready = await waitFor(status, (value) => value.status === "waiting-user");
  assert.equal(ready.mode, "off");
  assert.equal(ready.queuedClaudeContext, undefined); // Completion never auto-publishes.
  await hook("stop", { last_assistant_message: "New capture after review" });
  assert.equal((await status()).status, "waiting-user");
  assert.equal((await status()).pending.id, pulled.checkpointId);
  assert.equal((await call("/publish", { checkpointId: "stale" })).status, 409);
  const published = await call("/publish", { checkpointId: pulled.checkpointId });
  assert.equal(published.status, 200);
  assert.equal(published.value.mode, "off");
  assert.equal(published.value.delivery, "next-prompt");
  assert.ok(published.value.queuedClaudeContext);
  await hook("stop", { last_assistant_message: "New capture while feedback queued" });
  assert.equal((await status()).status, "waiting-claude");
  assert.match((await call("/pull-queue")).value.error, /feedback is already queued/);
  const delivered = await hook("prompt", { prompt: "Apply the feedback." });
  assert.match(delivered.value.additionalContext, /Fix the off-mode issue/);
  assert.equal((await status()).mode, "off");
  assert.equal((await status()).queuedClaudeContext, undefined);
  assert.equal((await hook("prompt", { prompt: "Another prompt." })).value.additionalContext, undefined);

  // Cancel a completed pull; the same capture remains protected from duplicate pulls.
  const cancelledPull = await command("pull_queue");
  const cancelReview = await waitFor(status, (value) => Boolean(value.pending?.codexTurnId));
  finish(cancelReview.pending.codexTurnId, "Feedback that must not be queued.");
  await waitFor(status, (value) => value.status === "waiting-user");
  const cancelled = await call("/cancel", { checkpointId: cancelledPull.checkpointId });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.value.mode, "off");
  assert.equal(cancelled.value.pending, undefined);
  assert.equal(cancelled.value.queuedClaudeContext, undefined);
  assert.match((await call("/pull-queue")).value.error, /already been queued/);
  assert.equal((await hook("prompt", { prompt: "Continue without feedback." })).value.additionalContext, undefined);
  const turnsBeforeStop = nextTurn;
  assert.equal((await hook("stop", { last_assistant_message: "Still not intercepted" })).value.kind, "allow");
  assert.equal(nextTurn, turnsBeforeStop);
  assert.equal((await status()).mode, "off");
  assert.equal((await status()).pending, undefined);
  // Recover active auto, then exercise explicit publication after pass and
  // continuation while real newer Stop requests are held and completed.
  await call("/mode", { mode: "auto", roundLimit: 3 });
  await command("resume");
  const recovered = await waitFor(status, (value) => Boolean(value.pending?.codexTurnId));
  await call("/auto-decision", { checkpointId: recovered.pending.id, decision: "pass" });
  finish(recovered.pending.codexTurnId, "Recovered pass.");
  await waitFor(status, (value) => value.status === "passed");
  const forced = await command("force_publish", { codexThreadId: "thread-test", feedback: "Explicit follow-up that must survive." });
  assert.equal(forced.delivery, "next-prompt");
  assert.equal(forced.mode, "auto");
  assert.equal(forced.autoRound, 0);
  assert.equal(forced.autoRoundLimit, 3);
  const messageId = forced.explicitClaudeMessage.id;
  assert.equal(forced.explicitClaudeMessage.preview, "Explicit follow-up that must survive.");
  assert.equal(forced.explicitClaudeMessage.feedback, undefined);
  assert.equal((await call("/force-publish", { codexThreadId: "thread-test", feedback: "Overwrite" })).status, 409);
  assert.equal((await call("/discard-message", { messageId: "stale" })).status, 409);

  const newerStop = hook("stop", { last_assistant_message: "Newer work after explicit publication" });
  const newer = await waitFor(status, (value) => Boolean(value.pending?.codexTurnId));
  assert.equal(newer.explicitClaudeMessage.id, messageId);
  assert.equal((await call("/force-publish", { codexThreadId: "thread-test", feedback: "Bypass checkpoint" })).status, 409);
  await call("/auto-decision", { checkpointId: newer.pending.id, decision: "pass_continue", continuation: "Perform the already-authorized next step." });
  finish(newer.pending.codexTurnId, "Clean; continue.");
  assert.equal((await newerStop).value.kind, "continue");
  const continued = await waitFor(status, (value) => !value.pending);
  assert.equal(continued.status, "waiting-claude");
  assert.equal(continued.autoRound, 1);
  assert.equal(continued.explicitClaudeMessage.id, messageId);
  await command("discard_message", { messageId });
  const afterContinue = await command("force_publish", { codexThreadId: "thread-test", feedback: "Explicit after continuation." });
  assert.equal(afterContinue.autoRound, 1);
  const retainedId = afterContinue.explicitClaudeMessage.id;

  const interimStop = hook("stop", { last_assistant_message: "Waiting for background work", background_tasks: [{ id: "task-1", type: "shell", status: "running" }] });
  const interim = await waitFor(status, (value) => Boolean(value.pending?.codexTurnId));
  assert.equal((await call("/defer", { checkpointId: interim.pending.id })).status, 200);
  finish(interim.pending.codexTurnId, "Deferred until background work completes.");
  assert.equal((await interimStop).value.kind, "allow");
  assert.equal((await status()).explicitClaudeMessage.id, retainedId);
  assert.equal((await status()).autoRound, 1);

  // Standby retains but never delivers it. Persistence survives a broker restart.
  await command("standby");
  assert.equal((await status()).explicitClaudeMessage.delivery, "paused");
  assert.equal((await hook("prompt", { prompt: "Work while paused" })).value.additionalContext, undefined);
  await hook("stop", { last_assistant_message: "New handoff collected during standby" });
  assert.equal((await call("/force-publish", { codexThreadId: "thread-test", feedback: "Cannot send on standby" })).status, 409);
  const stopped = once(broker!, "exit"); await call("/shutdown"); await stopped;
  await start();
  assert.equal((await status()).explicitClaudeMessage.id, retainedId);
  await command("resume");
  const resumed = await waitFor(status, (value) => Boolean(value.pending?.codexTurnId));
  // Promptless lifecycle hooks do not consume an explicit user message.
  await hook("prompt", {});
  assert.equal((await status()).explicitClaudeMessage.id, retainedId);
  assert.equal((await status()).status, "reviewing");
  await call("/auto-decision", { checkpointId: resumed.pending.id, decision: "revise" });
  finish(resumed.pending.codexTurnId, "Automatic correction also queued.");
  await waitFor(status, (value) => Boolean(value.queuedClaudeContext));
  const combined = await hook("prompt", { prompt: "Apply both messages." });
  assert.match(combined.value.additionalContext, /Automatic correction also queued/);
  assert.match(combined.value.additionalContext, /Explicit after continuation/);
  assert.match(combined.value.additionalContext, /Newer handoffs may have occurred/);
  assert.equal((await status()).explicitClaudeMessage, undefined);
  assert.equal((await status()).queuedClaudeContext, undefined);
  assert.equal((await hook("prompt", { prompt: "No duplicate delivery" })).value.additionalContext, undefined);

  const watchSnapshot = await call("/watch");
  assert.equal(watchSnapshot.value.snapshot.feedbackQueued, false);
  const cursor = watchSnapshot.value.cursor;
  assert.equal((await call("/watch", { after: -1 })).status, 400);
  assert.equal((await call("/watch", { after: cursor + 1 })).status, 409);
  const waitingWatch = call("/watch", { after: cursor });
  assert.equal((await status()).skipInterimReviews, false);
  assert.equal((await call("/pair/review-options", { skipInterimReviews: true })).value.skipInterimReviews, true);
  const beforeSkip = nextTurn;
  const tasks = [{ id: "task-2", type: "shell", status: "running" }];
  for (const message of ["First skipped handoff", "Second skipped handoff"]) {
    assert.equal((await hook("stop", { last_assistant_message: message, background_tasks: tasks })).value.kind, "allow");
  }
  assert.equal((await waitingWatch).value.events[0].type, "interim-skipped");
  assert.equal((await status()).pending, undefined);
  assert.equal(nextTurn, beforeSkip);
  const beforeFinal = once(broker!, "exit");
  await call("/shutdown");
  await beforeFinal;
  await start();
  assert.equal((await status()).skipInterimReviews, true);
  const finalStop = hook("stop", { last_assistant_message: "Final handoff after skipped reviews" });
  const finalReview = await waitFor(status, (value) => Boolean(value.pending?.codexTurnId));
  assert.equal(finalReview.pending.source, "stop");
  assert.equal(nextTurn, beforeSkip + 1);
  for (const message of ["First skipped handoff", "Second skipped handoff"]) {
    assert.ok(messages.some((rpc) => rpc.method === "thread/inject_items" && JSON.stringify(rpc).includes(message)));
  }
  await call("/auto-decision", { checkpointId: finalReview.pending.id, decision: "needs_user" });
  finish(finalReview.pending.codexTurnId, "This review requires a user decision.");
  await waitFor(status, (value) => value.status === "waiting-user");
  const pausedEvents = (await call("/watch", { after: cursor })).value.events;
  assert.deepEqual(pausedEvents.map((event: any) => event.type), [
    "interim-skipped", "interim-skipped", "broker-restarted", "checkpoint-created", "review-started", "review-finished", "paused"
  ]);
  assert.equal(pausedEvents.at(-2).decision, "needs_user");
  assert.equal(pausedEvents.at(-1).reason, "needs-user");
  assert.ok(!JSON.stringify(pausedEvents).includes("handoff"));
  const whilePaused = once(broker!, "exit");
  await call("/shutdown");
  await finalStop;
  await whilePaused;
  await start();
  const restartEvents = (await call("/watch", { after: pausedEvents.at(-1).sequence })).value.events;
  assert.deepEqual(restartEvents.map((event: any) => event.type), ["broker-restarted", "standby-entered"]);
  assert.equal(restartEvents.at(-1).reason, "broker-restart");
  await command("resume");
  const afterRestart = await waitFor(status, (value) => Boolean(value.pending?.codexTurnId));
  await call("/auto-decision", { checkpointId: afterRestart.pending.id, decision: "revise" });
  finish(afterRestart.pending.codexTurnId, "Apply the final review.");
  await waitFor(status, (value) => Boolean(value.queuedClaudeContext));
  await hook("prompt", { prompt: "Apply that review." });
  const deliveryEvents = (await call("/watch", { after: restartEvents.at(-1).sequence })).value.events;
  assert.deepEqual(deliveryEvents.map((event: any) => event.type), [
    "standby-left", "checkpoint-created", "review-started", "review-finished", "feedback-queued", "feedback-delivered"
  ]);
  assert.equal(deliveryEvents.at(-1).checkpointId, afterRestart.pending.id);
  assert.equal(deliveryEvents.at(-1).delivery, "next-prompt");

  // A queued revision is acknowledged only by the matching Claude transcript event.
  await call("/mode", { mode: "auto", roundLimit: 3 });
  await call("/pair/claude", { projectRoot: root, channelToken: launchToken });
  await hook("session", {});
  await command("standby");
  await hook("stop", { last_assistant_message: "Channel receipt fixture" });
  await command("resume");
  const receiptReview = await waitFor(status, (value) => Boolean(value.pending?.codexTurnId));
  await call("/auto-decision", { checkpointId: receiptReview.pending.id, decision: "revise" });
  finish(receiptReview.pending.codexTurnId, "Revision for receipt test.");
  await waitFor(status, (value) => Boolean(value.queuedClaudeContext));
  const receiptCursor = (await call("/watch")).value.cursor;
  const pendingReceipt = (await call("/channel/claim", binding)).value;
  const pendingBroker = once(broker!, "exit");
  await call("/shutdown");
  await pendingBroker;
  await start();
  assert.deepEqual((await call("/channel/claim", binding)).value, {});
  const channelTranscript = path.join(project, "claude-test.jsonl");
  const content = `<channel source="review-bridge-channel" receipt_id="${pendingReceipt.receiptId}">\nRevision\n</channel>`;
  fs.writeFileSync(channelTranscript, JSON.stringify({
    type: "user", sessionId: "claude-test", isMeta: true, origin: { kind: "human" }, message: { content }
  }) + "\n");
  assert.equal((await hook("prompt", { prompt: "Check fake receipt" })).value.additionalContext, undefined);
  assert.equal((await status()).autoDeliveryAwaitingReceipt, true);
  fs.appendFileSync(channelTranscript, JSON.stringify({
    type: "user", sessionId: "claude-test", isMeta: true, origin: { kind: "channel", server: "review-bridge-channel" }, message: { content }
  }) + "\n");
  fs.appendFileSync(channelTranscript, JSON.stringify({ type: "tool-result", content: "x".repeat(768 * 1024) }) + "\n");
  assert.equal((await hook("prompt", { prompt: "Check real receipt" })).value.additionalContext, undefined);
  assert.equal((await status()).queuedClaudeContext, undefined);
  const receipts = (await call("/watch", { after: receiptCursor })).value.events;
  assert.deepEqual(receipts.map((event: any) => event.type), ["feedback-dispatch-claimed", "broker-restarted", "feedback-delivered"]);
  assert.equal(receipts.at(-1).delivery, "claude-channel");

  // Discard is available on standby; mode-off explicitly reports removal.
  const toDiscard = await command("force_publish", { codexThreadId: "thread-test", feedback: "Discard this only." });
  await command("standby");
  const discarded = await command("discard_message", { messageId: toDiscard.explicitClaudeMessage.id });
  assert.equal(discarded.discardedExplicitMessageId, toDiscard.explicitClaudeMessage.id);
  assert.equal(discarded.activity, "standby");
  assert.equal(discarded.explicitClaudeMessage, undefined);
  await call("/mode", { mode: "manual" });
  const manual = await command("force_publish", { codexThreadId: "thread-test", feedback: "Manual message cleared by off." });
  const manualStop = hook("stop", { last_assistant_message: "New manual checkpoint" });
  const manualReview = await waitFor(status, (value) => Boolean(value.pending?.codexTurnId));
  finish(manualReview.pending.codexTurnId, "Review requiring a user decision.");
  await waitFor(status, (value) => value.status === "waiting-user");
  await call("/cancel", { checkpointId: manualReview.pending.id });
  assert.equal((await manualStop).value.kind, "allow");
  assert.equal((await status()).explicitClaudeMessage.id, manual.explicitClaudeMessage.id);
  const off = await call("/mode", { mode: "off" });
  assert.equal(off.value.discardedExplicitMessageId, manual.explicitClaudeMessage.id);
  assert.equal(off.value.explicitClaudeMessage, undefined);
  assert.equal((await hook("prompt", { prompt: "Off must not deliver" })).value.additionalContext, undefined);
});
