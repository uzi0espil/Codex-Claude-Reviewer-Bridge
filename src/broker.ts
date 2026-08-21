import fs from "node:fs";
import http, { IncomingMessage, ServerResponse } from "node:http";
import net from "node:net";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn, ChildProcess } from "node:child_process";
import { AppServerClient, CompletedTurn } from "./app-server.js";
import { endpointPath, featureKey, logPath, reviewerRoot, runtimeDirectory } from "./paths.js";
import { StateStore } from "./store.js";
import { AutoReviewResult, BridgeMode, ClaudeHookInput, EndpointFile, FeaturePair } from "./types.js";
import { buildReviewPrompt } from "./review-prompt.js";
import { modeAfterUserDecision } from "./mode-policy.js";
import { buildPublishedFeedback } from "./published-feedback.js";
import { checkpointDecisionError, createCheckpoint, forcePublishError } from "./checkpoint-policy.js";
import { startStreamedJsonResponse } from "./streamed-json-response.js";
import { buildQuestionAdvisoryPrompt, createQuestionAdvisory } from "./question-advisory.js";
import { migrateClaudeSessionLifecycle, recordClaudeSession } from "./claude-session.js";

type Release = { kind: "allow" } | { kind: "feedback"; text: string };
type Waiter = { resolve: (release: Release) => void; response: ServerResponse; onClose: () => void };

const store = new StateStore();
const waiters = new Map<string, Waiter>();
const reviewTransitions = new Map<string, Promise<void>>();
const questionTransitions = new Map<string, Promise<void>>();
const token = randomBytes(32).toString("hex");
let appProcess: ChildProcess | undefined;
let app: AppServerClient;
let shutdownBroker: () => void = () => undefined;

function log(message: string): void {
  fs.mkdirSync(runtimeDirectory, { recursive: true });
  fs.appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`);
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function startAppServer(): Promise<string> {
  const port = await freePort();
  const url = `ws://127.0.0.1:${port}`;
  const npmRoot = process.env.APPDATA ? path.join(process.env.APPDATA, "npm") : "";
  const cliScript = path.join(npmRoot, "node_modules", "@openai", "codex", "bin", "codex.js");
  const command = fs.existsSync(cliScript) ? process.execPath : "codex";
  const args = fs.existsSync(cliScript)
    ? [cliScript, "app-server", "--listen", url]
    : ["app-server", "--listen", url];
  appProcess = spawn(command, args, {
    cwd: reviewerRoot,
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, CODEX_HOME: reviewerRoot }
  });
  appProcess.stderr?.on("data", (data) => log(`[app-server] ${String(data).trimEnd()}`));
  appProcess.once("exit", (code) => log(`[app-server] exited with ${code}`));

  app = new AppServerClient(url);
  let lastError: unknown;
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      await app.connect();
      app.on("turnCompleted", (turn: CompletedTurn) => void handleTurnCompleted(turn));
      log(`Codex app-server ready at ${url}`);
      return url;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 125));
    }
  }
  appProcess.kill();
  throw new Error(`Codex app-server did not start: ${String(lastError)}`);
}

async function ensureCodexThread(pair: FeaturePair): Promise<FeaturePair> {
  if (pair.codexThreadId) {
    try {
      await app.resumeThread(pair.codexThreadId, pair.projectRoot);
      return pair;
    } catch (error) {
      log(`Could not resume ${pair.codexThreadId}; creating replacement: ${String(error)}`);
    }
  }
  const threadId = await app.createThread(pair.projectRoot, pair.displayName);
  pair = store.update(pair.feature, (current) => { current.codexThreadId = threadId; });
  if (!pair.pmSeeded && pair.initialPrompt) {
        await app.seedContext(threadId, `[Workstream context: ${pair.displayName}]\n${pair.initialPrompt}`);
    pair = store.update(pair.feature, (current) => {
      current.pmSeeded = true;
      current.initialPrompt = undefined;
    });
  }
  return pair;
}

async function interruptReview(threadId: string, turnId: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  let completed = false;
  let resolveCompletion: (() => void) | undefined;
  const onCompleted = (turn: CompletedTurn): void => {
    if (turn.threadId !== threadId || turn.turnId !== turnId) return;
    completed = true;
    resolveCompletion?.();
  };
  const completion = new Promise<void>((resolve) => {
    resolveCompletion = resolve;
    app.on("turnCompleted", onCompleted);
    timer = setTimeout(resolve, 10_000);
  });
  try {
    await app.interruptTurn(threadId, turnId);
    await completion;
    if (!completed) log(`Timed out waiting for interrupted Codex turn ${turnId} to complete.`);
  } catch (error) {
    log(`Could not interrupt obsolete Codex turn ${turnId}: ${String(error)}`);
  } finally {
    if (timer) clearTimeout(timer);
    app.off("turnCompleted", onCompleted);
  }
}

async function startReview(pair: FeaturePair, pendingId: string): Promise<void> {
  pair = await ensureCodexThread(pair);
  const current = store.get(pair.feature);
  if (!current?.pending || current.pending.id !== pendingId) return;
  const checkpoint = current.pending;
  const turnId = await app.startReview(
    pair.codexThreadId!,
    pair.projectRoot,
    buildReviewPrompt(pair, checkpoint.claudeMessage, checkpoint),
    pair.mode === "auto"
  );
  const latest = store.get(pair.feature);
  if (!latest?.pending || latest.pending.id !== pendingId) {
    await interruptReview(pair.codexThreadId!, turnId);
    return;
  }
  store.update(pair.feature, (value) => {
    if (value.pending?.id === pendingId) value.pending.codexTurnId = turnId;
  });
}

function scheduleQuestionAdvisory(feature: string): void {
  const previous = questionTransitions.get(feature) ?? Promise.resolve();
  const transition = previous
    .catch((error) => log(`Prior question advisory transition failed for ${feature}: ${String(error)}`))
    .then(async () => {
      let pair = store.get(feature);
      if (!pair || pair.activeQuestionAdvisory || !pair.questionAdvisoryQueue?.length) return;
      if (pair.status === "reviewing" && pair.pending?.codexTurnId && !pair.pending.codexResponse) return;
      pair = await ensureCodexThread(pair);
      const current = store.get(feature);
      const advisory = current?.questionAdvisoryQueue?.[0];
      if (!current || current.activeQuestionAdvisory || !advisory) return;
      if (current.status === "reviewing" && current.pending?.codexTurnId && !current.pending.codexResponse) return;
      try {
        const turnId = await app.startQuestionAdvisory(
          current.codexThreadId!,
          current.projectRoot,
          buildQuestionAdvisoryPrompt(current, advisory)
        );
        let installed = false;
        store.update(feature, (value) => {
          if (value.activeQuestionAdvisory || value.questionAdvisoryQueue?.[0]?.id !== advisory.id) return;
          value.questionAdvisoryQueue.shift();
          if (!value.questionAdvisoryQueue.length) value.questionAdvisoryQueue = undefined;
          value.activeQuestionAdvisory = { ...advisory, codexTurnId: turnId };
          installed = true;
        });
        if (!installed) {
          await interruptReview(current.codexThreadId!, turnId);
          log(`Discarded question advisory turn ${turnId} because ${advisory.id} became obsolete before it started.`);
          return;
        }
        log(`Started question advisory ${advisory.id} for ${feature} as Codex turn ${turnId}.`);
      } catch (error) {
        // A user-driven Codex turn may already be active. Keep the advisory queued;
        // turn/completed will trigger another event-driven dispatch attempt.
        log(`Question advisory ${advisory.id} remains queued for ${feature}: ${String(error)}`);
      }
    });
  questionTransitions.set(feature, transition);
  void transition.finally(() => {
    if (questionTransitions.get(feature) === transition) questionTransitions.delete(feature);
  });
}

function scheduleReview(pair: FeaturePair, pendingId: string, supersededTurnId?: string): void {
  const previous = reviewTransitions.get(pair.feature) ?? Promise.resolve();
  const transition = previous
    .catch((error) => log(`Prior review transition failed for ${pair.feature}: ${String(error)}`))
    .then(async () => {
      try {
        const current = store.get(pair.feature);
        if (!current?.pending || current.pending.id !== pendingId) return;
        const advisoryTurnId = current.activeQuestionAdvisory?.codexTurnId;
        if (advisoryTurnId && current.codexThreadId) {
          await interruptReview(current.codexThreadId, advisoryTurnId);
          const latest = store.get(pair.feature);
          if (latest?.activeQuestionAdvisory?.codexTurnId === advisoryTurnId) {
            store.update(pair.feature, (value) => { value.activeQuestionAdvisory = undefined; });
          }
          log(`Interrupted obsolete question advisory turn ${advisoryTurnId} for checkpoint ${pendingId}.`);
        }
        if (supersededTurnId && current.codexThreadId) {
          await interruptReview(current.codexThreadId, supersededTurnId);
        }
        const latest = store.get(pair.feature);
        if (!latest?.pending || latest.pending.id !== pendingId) return;
        await startReview(latest, pendingId);
      } catch (error) {
        log(`Review failed for ${pair.feature}: ${String(error)}`);
        const current = store.get(pair.feature);
        if (!current?.pending || current.pending.id !== pendingId) return;
        store.update(pair.feature, (value) => {
          value.status = "failed";
          value.mode = "off";
          value.pending = undefined;
        });
        release(pendingId, { kind: "allow" });
        log(`Fail-open release for ${pair.feature}`);
      }
    });
  reviewTransitions.set(pair.feature, transition);
  void transition.finally(() => {
    if (reviewTransitions.get(pair.feature) === transition) reviewTransitions.delete(pair.feature);
  });
}

function release(pendingId: string, result: Release): void {
  const waiter = waiters.get(pendingId);
  if (waiter) {
    waiters.delete(pendingId);
    waiter.response.removeListener("close", waiter.onClose);
    waiter.resolve(result);
  }
}

function parseAuto(text: string): AutoReviewResult {
  const value = JSON.parse(text) as Partial<AutoReviewResult>;
  if (!value || !["pass", "revise", "needs_user"].includes(String(value.decision))) {
    throw new Error("Codex returned an invalid auto-review decision.");
  }
  return {
    decision: value.decision as AutoReviewResult["decision"],
    feedback: String(value.feedback ?? ""),
    summary: String(value.summary ?? "")
  };
}

async function finishReview(turn: CompletedTurn): Promise<void> {
  const pair = store.all().find((candidate) => candidate.pending?.codexTurnId === turn.turnId);
  if (!pair?.pending) return;
  const pendingId = pair.pending.id;
  if (turn.status !== "completed" || !turn.text) {
    store.update(pair.feature, (value) => {
      value.status = "failed";
      value.mode = "off";
      value.pending = undefined;
    });
    release(pendingId, { kind: "allow" });
    return;
  }

  if (pair.mode !== "auto") {
    store.update(pair.feature, (value) => {
      value.status = "waiting-user";
      value.lastCodexResponse = turn.text;
      if (value.pending) value.pending.codexResponse = turn.text;
    });
    return;
  }

  try {
    const result = parseAuto(turn.text);
    if (result.decision === "pass") {
      store.update(pair.feature, (value) => {
        value.status = "passed";
        value.mode = "off";
        value.autoRound = 0;
        value.lastCodexResponse = result.summary;
        value.pending = undefined;
      });
      release(pendingId, { kind: "allow" });
    } else if (result.decision === "revise" && pair.autoRound < 3) {
      const feedback = buildPublishedFeedback(result.feedback);
      store.update(pair.feature, (value) => {
        value.status = "waiting-claude";
        value.autoRound += 1;
        value.lastCodexResponse = result.feedback;
        value.pending = undefined;
      });
      release(pendingId, { kind: "feedback", text: feedback });
    } else {
      store.update(pair.feature, (value) => {
        value.status = "waiting-user";
        value.lastCodexResponse = result.feedback || result.summary;
        if (value.pending) value.pending.codexResponse = result.feedback || result.summary;
      });
    }
  } catch (error) {
    log(`Auto response requires user review: ${String(error)}`);
    store.update(pair.feature, (value) => {
      value.status = "waiting-user";
      value.lastCodexResponse = turn.text;
      if (value.pending) value.pending.codexResponse = turn.text;
    });
  }
}

function finishQuestionAdvisory(turn: CompletedTurn): void {
  const pair = store.all().find((candidate) => candidate.activeQuestionAdvisory?.codexTurnId === turn.turnId);
  if (!pair?.activeQuestionAdvisory) return;
  const advisoryId = pair.activeQuestionAdvisory.id;
  store.update(pair.feature, (value) => { value.activeQuestionAdvisory = undefined; });
  log(`Question advisory ${advisoryId} for ${pair.feature} finished with status ${turn.status}.`);
}

async function handleTurnCompleted(turn: CompletedTurn): Promise<void> {
  await finishReview(turn);
  finishQuestionAdvisory(turn);
  for (const pair of store.all()) {
    if (pair.codexThreadId === turn.threadId && pair.questionAdvisoryQueue?.length) {
      scheduleQuestionAdvisory(pair.feature);
    }
  }
}

function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    req.on("data", (chunk: Buffer) => {
      length += chunk.length;
      if (length > 2_000_000) {
        reject(new Error("Request body is too large."));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on("end", () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); }
      catch (error) { reject(error); }
    });
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function publicPair(pair: FeaturePair): Record<string, unknown> {
  return {
    ...pair,
    claudeSessionStarted: pair.claudeSessionStarted ?? false,
    initialPrompt: pair.initialPrompt ? "[held until Codex thread is ready]" : undefined,
    queuedClaudeContext: pair.queuedClaudeContext ? "[queued for Claude's next prompt]" : undefined,
    lastCodexResponse: pair.lastCodexResponse ? "[held by bridge]" : undefined,
    questionAdvisoryQueue: pair.questionAdvisoryQueue?.map((item) => ({ id: item.id, createdAt: item.createdAt })),
    activeQuestionAdvisory: pair.activeQuestionAdvisory ? {
      id: pair.activeQuestionAdvisory.id,
      createdAt: pair.activeQuestionAdvisory.createdAt,
      codexTurnId: pair.activeQuestionAdvisory.codexTurnId
    } : undefined,
    seenQuestionAdvisoryIds: pair.seenQuestionAdvisoryIds?.length ?? 0,
    pending: pair.pending ? {
      ...pair.pending,
      claudeMessage: "[held by bridge]",
      codexResponse: pair.pending.codexResponse ? "[held by bridge]" : undefined
    } : undefined
  };
}

async function route(req: IncomingMessage, res: ServerResponse, appServerUrl: string): Promise<void> {
  if (req.url === "/health" && req.method === "GET") return send(res, 200, { ok: true, appServerUrl });
  if (req.headers.authorization !== `Bearer ${token}`) return send(res, 401, { error: "unauthorized" });
  const body = await readJson(req);
  const feature = body.feature ? featureKey(String(body.feature)) : undefined;

  if (req.url === "/shutdown" && req.method === "POST") {
    send(res, 200, { ok: true });
    setImmediate(shutdownBroker);
    return;
  }

  if (req.url === "/pair/claude" && req.method === "POST") {
    let pair = store.ensure(String(body.feature), String(body.projectRoot));
    pair = store.update(pair.feature, (value) => {
      migrateClaudeSessionLifecycle(value);
      value.claudeSessionId = String(body.sessionId || value.claudeSessionId || randomUUID());
    });
    return send(res, 200, publicPair(pair));
  }
  if (req.url === "/pair/codex" && req.method === "POST") {
    let pair = store.ensure(String(body.feature), String(body.projectRoot));
    pair = await ensureCodexThread(pair);
    send(res, 200, { ...publicPair(pair), appServerUrl });
    scheduleQuestionAdvisory(pair.feature);
    return;
  }
  if (req.url === "/pairs" && req.method === "GET") return send(res, 200, store.all().map(publicPair));
  if (req.url === "/status" && req.method === "POST") {
    const pair = feature ? store.get(feature) : undefined;
    return pair ? send(res, 200, publicPair(pair)) : send(res, 404, { error: "unknown feature" });
  }
  if (req.url === "/mode" && req.method === "POST") {
    if (!feature || !["off", "manual", "once", "auto"].includes(String(body.mode))) return send(res, 400, { error: "invalid feature or mode" });
    const existing = store.get(feature);
    const advisoryTurnId = body.mode === "off" ? existing?.activeQuestionAdvisory?.codexTurnId : undefined;
    const pair = store.update(feature, (value) => {
      value.mode = body.mode as BridgeMode;
      value.autoRound = 0;
      if (body.mode === "off") {
        value.status = "idle";
        if (value.pending) release(value.pending.id, { kind: "allow" });
        value.pending = undefined;
        value.queuedClaudeContext = undefined;
        value.questionAdvisoryQueue = undefined;
        value.activeQuestionAdvisory = undefined;
      }
    });
    if (advisoryTurnId && pair.codexThreadId) {
      await interruptReview(pair.codexThreadId, advisoryTurnId);
      log(`Interrupted question advisory turn ${advisoryTurnId} because ${feature} was switched off.`);
    }
    return send(res, 200, publicPair(pair));
  }
  if (req.url === "/publish" && req.method === "POST") {
    if (!feature) return send(res, 400, { error: "feature required" });
    const existing = store.get(feature);
    if (!existing) return send(res, 404, { error: "unknown feature" });
    const decisionError = checkpointDecisionError(existing, body.checkpointId, true);
    if (decisionError) return send(res, 409, { error: decisionError });
    const review = String(body.feedback || existing.pending?.codexResponse || "").trim();
    if (!review) return send(res, 409, { error: "no Codex response or custom feedback to publish" });
    const text = buildPublishedFeedback(review);
    const pendingId = existing.pending?.id;
    const delivery = pendingId && waiters.has(pendingId) ? "stop-hook" : "next-prompt";
    const pair = store.update(feature, (value) => {
      value.mode = modeAfterUserDecision(existing.mode);
      value.autoRound = 0;
      value.status = "waiting-claude";
      value.pending = undefined;
      if (delivery === "next-prompt") value.queuedClaudeContext = text;
    });
    if (pendingId) release(pendingId, { kind: "feedback", text });
    return send(res, 200, { ...publicPair(pair), delivery });
  }
  if (req.url === "/force-publish" && req.method === "POST") {
    if (!feature) return send(res, 400, { error: "feature required" });
    const existing = store.get(feature);
    if (!existing) return send(res, 404, { error: "unknown feature" });
    const publishError = forcePublishError(existing, body.codexThreadId, body.feedback);
    if (publishError) return send(res, 409, { error: publishError });
    const review = String(body.feedback).trim();
    const text = buildPublishedFeedback(review);
    const publishedAt = new Date().toISOString();
    const pair = store.update(feature, (value) => {
      value.status = "waiting-claude";
      value.queuedClaudeContext = text;
      value.lastCodexResponse = review;
      value.lastForcedPublishAt = publishedAt;
      value.lastForcedPublishThreadId = String(body.codexThreadId);
    });
    log(`Forced unheld publication queued for ${feature} from Codex thread ${String(body.codexThreadId)}.`);
    return send(res, 200, { ...publicPair(pair), delivery: "next-prompt", forced: true });
  }
  if (req.url === "/cancel" && req.method === "POST") {
    if (!feature) return send(res, 400, { error: "feature required" });
    const existing = store.get(feature);
    if (!existing) return send(res, 404, { error: "unknown feature" });
    const decisionError = checkpointDecisionError(existing, body.checkpointId, false);
    if (decisionError) return send(res, 409, { error: decisionError });
    const pendingId = existing.pending?.id;
    const pair = store.update(feature, (value) => {
      value.mode = modeAfterUserDecision(existing.mode);
      value.autoRound = 0;
      value.status = "idle";
      value.pending = undefined;
    });
    if (pendingId) release(pendingId, { kind: "allow" });
    return send(res, 200, publicPair(pair));
  }
  if (req.url === "/hook/prompt" && req.method === "POST") {
    const input = body.input as ClaudeHookInput;
    const pair = store.update(String(body.feature), (value) => {
      recordClaudeSession(value, input.session_id, true);
    });
    let context = pair.queuedClaudeContext
      ? buildPublishedFeedback(pair.queuedClaudeContext)
      : undefined;
    if (context) store.update(pair.feature, (value) => {
      value.queuedClaudeContext = undefined;
      value.status = value.mode === "manual" ? "waiting-claude" : "idle";
    });
    if (!pair.pmSeeded && input.prompt) {
      if (pair.codexThreadId) {
        await app.seedContext(pair.codexThreadId, `[Workstream context: ${pair.displayName}]\n${input.prompt}`);
        store.update(pair.feature, (value) => { value.pmSeeded = true; value.initialPrompt = undefined; });
      } else {
        store.update(pair.feature, (value) => { value.initialPrompt = input.prompt; });
      }
    }
    return send(res, 200, { additionalContext: context, sessionTitle: pair.displayName });
  }
  if (req.url === "/hook/session" && req.method === "POST") {
    const input = body.input as ClaudeHookInput;
    const pair = store.update(String(body.feature), (value) => {
      recordClaudeSession(value, input.session_id, false);
    });
    return send(res, 200, publicPair(pair));
  }
  if (req.url === "/hook/question" && req.method === "POST") {
    const input = body.input as ClaudeHookInput;
    const advisory = createQuestionAdvisory(input);
    if (!feature || !advisory) return send(res, 200, { accepted: false, reason: "invalid AskUserQuestion hook input" });
    const existing = store.get(feature);
    if (!existing) return send(res, 200, { accepted: false, reason: "unknown feature" });
    if (existing.mode === "off") return send(res, 200, { accepted: false, reason: "bridge mode is off" });
    if (existing.seenQuestionAdvisoryIds?.includes(advisory.id)) {
      return send(res, 200, { accepted: true, duplicate: true, id: advisory.id });
    }
    store.update(feature, (value) => {
      recordClaudeSession(value, input.session_id, true);
      value.questionAdvisoryQueue = [...(value.questionAdvisoryQueue ?? []), advisory];
      value.seenQuestionAdvisoryIds = [...(value.seenQuestionAdvisoryIds ?? []), advisory.id].slice(-100);
    });
    send(res, 200, { accepted: true, duplicate: false, id: advisory.id });
    log(`Queued Claude question ${advisory.id} for ${feature}.`);
    scheduleQuestionAdvisory(feature);
    return;
  }
  if (req.url === "/hook/stop" && req.method === "POST") {
    const input = body.input as ClaudeHookInput;
    const pair = store.get(String(body.feature));
    if (!pair || pair.mode === "off" || !input.last_assistant_message) return send(res, 200, { kind: "allow" });
    const superseded = pair.pending;
    const supersededQueuedFeedback = Boolean(pair.queuedClaudeContext);
    const pendingId = store.newPendingId();
    const checkpoint = createCheckpoint(pair, pendingId, input.last_assistant_message);
    const current = store.update(pair.feature, (value) => {
      recordClaudeSession(value, input.session_id, true);
      value.status = "reviewing";
      value.checkpointSequence = checkpoint.sequence;
      value.pending = checkpoint;
      value.queuedClaudeContext = undefined;
      value.questionAdvisoryQueue = undefined;
      value.lastCodexResponse = undefined;
    });
    if (superseded) {
      release(superseded.id, { kind: "allow" });
      log(`Checkpoint ${pendingId} superseded unpublished checkpoint ${superseded.id} for ${pair.feature}.`);
    }
    if (supersededQueuedFeedback) {
      log(`Checkpoint ${pendingId} superseded feedback queued for Claude's next prompt for ${pair.feature}.`);
    }
    let resolveRelease!: (release: Release) => void;
    const releasePromise = new Promise<Release>((resolve) => {
      resolveRelease = resolve;
    });
    const onClose = (): void => {
      if (waiters.delete(pendingId)) {
        log(`Claude Stop hook disconnected while review ${pendingId} was pending.`);
        resolveRelease({ kind: "allow" });
      }
    };
    waiters.set(pendingId, { resolve: resolveRelease, response: res, onClose });
    res.once("close", onClose);
    const streamedResponse = startStreamedJsonResponse(res);
    scheduleReview(
      current,
      pendingId,
      superseded?.codexTurnId && !superseded.codexResponse ? superseded.codexTurnId : undefined
    );
    const released = await releasePromise;
    streamedResponse.finish(released);
    return;
  }
  return send(res, 404, { error: "not found" });
}

async function main(): Promise<void> {
  fs.mkdirSync(runtimeDirectory, { recursive: true });
  const appServerUrl = await startAppServer();
  const server = http.createServer((req, res) => {
    void route(req, res, appServerUrl).catch((error) => {
      log(`HTTP error: ${String(error)}`);
      if (!res.headersSent) send(res, 500, { error: error instanceof Error ? error.message : String(error) });
      else res.end();
    });
  });
  server.keepAliveTimeout = 65_000;
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Could not determine bridge port.");
    const endpoint: EndpointFile = {
      url: `http://127.0.0.1:${address.port}`,
      token,
      appServerUrl,
      pid: process.pid,
      startedAt: new Date().toISOString()
    };
    fs.writeFileSync(endpointPath, `${JSON.stringify(endpoint, null, 2)}\n`, { mode: 0o600 });
    log(`Bridge ready at ${endpoint.url}`);
  });

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const pendingId of [...waiters.keys()]) release(pendingId, { kind: "allow" });
    try {
      const endpoint = JSON.parse(fs.readFileSync(endpointPath, "utf8")) as EndpointFile;
      if (endpoint.pid === process.pid) fs.unlinkSync(endpointPath);
    } catch { /* already gone or owned by another broker */ }
    appProcess?.kill();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 4_000).unref();
  };
  shutdownBroker = shutdown;
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main().catch((error) => {
  log(`Fatal: ${error instanceof Error ? error.stack : String(error)}`);
  process.exitCode = 1;
});
