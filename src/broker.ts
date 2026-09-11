import fs from "node:fs";
import http, { IncomingMessage, ServerResponse } from "node:http";
import net from "node:net";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn, ChildProcess } from "node:child_process";
import { AppServerClient, CompletedTurn, StartedTurn } from "./app-server.js";
import { AppServerProxy } from "./app-server-proxy.js";
import { endpointPath, featureKey, logPath, reviewerRoot, runtimeDirectory } from "./paths.js";
import { StateStore } from "./store.js";
import { AutoReviewDecision, BridgeMode, ClaudeHookInput, EndpointFile, FeaturePair } from "./types.js";
import { buildPulledReviewPrompt, buildReviewContextSeed, buildReviewPrompt, reviewContextSnapshot } from "./review-prompt.js";
import { autoRoundLimitError, autoRoundLimitForMode, modeAfterUserDecision, reviewTurnCompletion } from "./mode-policy.js";
import { buildPublishedFeedback } from "./published-feedback.js";
import { checkpointDecisionError, createCheckpoint, forcePublishError } from "./checkpoint-policy.js";
import {
  autoDecisionError,
  buildAutoContinuation,
  buildAutoCycleStatus,
  resolveAutoReview
} from "./auto-review.js";
import { startStreamedJsonResponse } from "./streamed-json-response.js";
import { buildQuestionAdvisoryPrompt, createQuestionAdvisory } from "./question-advisory.js";
import { migrateClaudeSessionLifecycle, recordClaudeSession } from "./claude-session.js";
import { StopHookResult } from "./claude-hook-output.js";
import { runSingleFlight } from "./single-flight.js";
import { planAutoDelivery } from "./auto-delivery.js";
import { CodexThreadBusyError, isCodexThreadBusyError } from "./codex-turn-policy.js";
import { captureClaudeMessage, createPulledReview, pullQueueError, pullReviewError } from "./pulled-message.js";
import { SessionReportLedger } from "./session-report.js";
import { readInstanceDefaultMode } from "./instance-config.js";
import { checkpointDeferralError, normalizeBackgroundTasks } from "./interim-review.js";

type Release = StopHookResult;
type Waiter = { resolve: (release: Release) => void; response: ServerResponse; onClose: () => void };

const store = new StateStore();
const waiters = new Map<string, Waiter>();
const reviewTransitions = new Map<string, Promise<void>>();
const questionTransitions = new Map<string, Promise<void>>();
const pulledReviewTransitions = new Map<string, Promise<void>>();
const threadInitializations = new Map<string, Promise<FeaturePair>>();
const activeCodexThreads = new Set<string>();
const token = randomBytes(32).toString("hex");
const brokerStartedAt = new Date().toISOString();
const sessionReports = new SessionReportLedger(brokerStartedAt);
let appProcess: ChildProcess | undefined;
let app: AppServerClient;
let appProxy: AppServerProxy | undefined;
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
      app.on("turnStarted", (turn: StartedTurn) => {
        if (turn.threadId) activeCodexThreads.add(turn.threadId);
      });
      app.on("turnCompleted", (turn: CompletedTurn) => void handleTurnCompleted(turn));
      app.on("contextCompacted", (threadId: string) => {
        const pair = store.all().find((candidate) => candidate.codexThreadId === threadId);
        if (!pair) return;
        store.update(pair.feature, (current) => { current.reviewContextCompacted = true; });
        log(`Codex compacted thread ${threadId}; the next bridge turn will receive one policy-file reminder without reseeding the full policy.`);
      });
      appProxy = await AppServerProxy.start(app);
      log(`Codex app-server ready at ${url}; reviewer proxy ready at ${appProxy.url}`);
      return appProxy.url;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 125));
    }
  }
  appProcess.kill();
  throw new Error(`Codex app-server did not start: ${String(lastError)}`);
}

async function initializeCodexThread(feature: string): Promise<FeaturePair> {
  let pair = store.get(feature);
  if (!pair) throw new Error(`Unknown feature '${feature}'. Launch a paired session first.`);
  let threadId: string | undefined;
  if (pair.codexThreadId) {
    try {
      await app.resumeThread(pair.codexThreadId, pair.projectRoot);
      threadId = pair.codexThreadId;
    } catch (error) {
      log(`Could not resume ${pair.codexThreadId}; creating replacement: ${String(error)}`);
    }
  }
  if (!threadId) {
    threadId = await app.createThread(pair.projectRoot, pair.displayName);
    pair = store.update(pair.feature, (current) => {
      current.codexThreadId = threadId;
      current.reviewContextSha256 = undefined;
      current.reviewContextCompacted = false;
      current.workstreamContextThreadId = undefined;
    });
  }

  pair = store.get(pair.feature) ?? pair;
  if (pair.workstreamContext && pair.workstreamContextThreadId !== threadId) {
    await app.seedContext(threadId, `[Workstream context: ${pair.displayName}]\n${pair.workstreamContext}`);
    pair = store.update(pair.feature, (current) => {
      if (current.codexThreadId !== threadId) return;
      current.pmSeeded = true;
      current.initialPrompt = undefined;
      current.workstreamContextThreadId = threadId;
    });
    log(`Seeded workstream context into Codex thread ${threadId} for ${pair.feature}.`);
  }
  const context = reviewContextSnapshot();
  if (pair.reviewContextSha256 !== context.sha256) {
    await app.seedContext(threadId, buildReviewContextSeed(pair, context));
    pair = store.update(pair.feature, (current) => {
      if (current.codexThreadId === threadId) {
        current.reviewContextSha256 = context.sha256;
        current.reviewContextCompacted = false;
      }
    });
    log(`Seeded bridge context ${context.sha256} into Codex thread ${threadId} for ${pair.feature}.`);
  }
  return pair;
}

async function ensureCodexThread(pair: FeaturePair): Promise<FeaturePair> {
  return await runSingleFlight(threadInitializations, pair.feature, () => initializeCodexThread(pair.feature));
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
  if (pair.codexThreadId && activeCodexThreads.has(pair.codexThreadId)) {
    throw new CodexThreadBusyError(pair.codexThreadId);
  }
  pair = await ensureCodexThread(pair);
  const current = store.get(pair.feature);
  if (!current?.pending || current.pending.id !== pendingId) return;
  const checkpoint = current.pending;
  if (activeCodexThreads.has(pair.codexThreadId!)) throw new CodexThreadBusyError(pair.codexThreadId!);
  const consumedCompactionReminder = Boolean(pair.reviewContextCompacted);
  const turnId = await app.startReview(
    pair.codexThreadId!,
    pair.projectRoot,
    buildReviewPrompt(pair, checkpoint.claudeMessage, checkpoint)
  );
  const latest = store.get(pair.feature);
  if (!latest?.pending || latest.pending.id !== pendingId) {
    await interruptReview(pair.codexThreadId!, turnId);
    return;
  }
  store.update(pair.feature, (value) => {
    if (value.pending?.id === pendingId) {
      value.pending.codexTurnId = turnId;
      if (consumedCompactionReminder) value.reviewContextCompacted = false;
    }
  });
  sessionReports.update(pair.feature, pendingId, { codexTurnId: turnId });
  log(`Started Codex review turn ${turnId} for ${pair.feature} checkpoint ${pendingId}.`);
}

function scheduleQuestionAdvisory(feature: string): void {
  const previous = questionTransitions.get(feature) ?? Promise.resolve();
  const transition = previous
    .catch((error) => log(`Prior question advisory transition failed for ${feature}: ${String(error)}`))
    .then(async () => {
      let pair = store.get(feature);
      if (!pair || pair.activeQuestionAdvisory || !pair.questionAdvisoryQueue?.length) return;
      if (pair.status === "reviewing" && pair.pending?.codexTurnId && !pair.pending.codexResponse) return;
      if (pair.codexThreadId && activeCodexThreads.has(pair.codexThreadId)) return;
      pair = await ensureCodexThread(pair);
      const current = store.get(feature);
      const advisory = current?.questionAdvisoryQueue?.[0];
      if (!current || current.activeQuestionAdvisory || !advisory) return;
      if (current.status === "reviewing" && current.pending?.codexTurnId && !current.pending.codexResponse) return;
      if (activeCodexThreads.has(current.codexThreadId!)) return;
      try {
        const consumedCompactionReminder = Boolean(current.reviewContextCompacted);
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
          if (consumedCompactionReminder) value.reviewContextCompacted = false;
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

function schedulePulledReview(feature: string): void {
  const previous = pulledReviewTransitions.get(feature) ?? Promise.resolve();
  const transition = previous
    .catch((error) => log(`Prior pulled-review transition failed for ${feature}: ${String(error)}`))
    .then(async () => {
      let pair = store.get(feature);
      const pulled = pair?.pulledReview;
      if (!pair || !pulled || pulled.codexTurnId) return;
      if (pair.pending || pair.queuedClaudeContext) return;
      if (pair.codexThreadId && activeCodexThreads.has(pair.codexThreadId)) return;
      pair = await ensureCodexThread(pair);
      const current = store.get(feature);
      if (!current?.pulledReview || current.pulledReview.id !== pulled.id || current.pending) return;
      if (activeCodexThreads.has(current.codexThreadId!)) return;
      try {
        const consumedCompactionReminder = Boolean(current.reviewContextCompacted);
        const turnId = await app.startReview(
          current.codexThreadId!,
          current.projectRoot,
          buildPulledReviewPrompt(current, current.pulledReview)
        );
        let installed = false;
        store.update(feature, (value) => {
          if (value.pulledReview?.id !== pulled.id || value.pending) return;
          value.pulledReview.codexTurnId = turnId;
          if (consumedCompactionReminder) value.reviewContextCompacted = false;
          installed = true;
        });
        if (!installed) {
          await interruptReview(current.codexThreadId!, turnId);
          return;
        }
        log(`Started pulled review ${pulled.id} for ${feature} as Codex turn ${turnId}.`);
      } catch (error) {
        if (isCodexThreadBusyError(error) || activeCodexThreads.has(current.codexThreadId!)) {
          log(`Pulled review ${pulled.id} remains queued for ${feature} until the active Codex turn completes.`);
          return;
        }
        store.update(feature, (value) => {
          if (value.pulledReview?.id !== pulled.id) return;
          if (value.capturedClaudeMessage?.id === pulled.capturedMessageId) {
            value.capturedClaudeMessage.reviewRequestedAt = undefined;
          }
          value.pulledReview = undefined;
        });
        log(`Pulled review ${pulled.id} failed to start for ${feature}: ${String(error)}`);
      }
    });
  pulledReviewTransitions.set(feature, transition);
  void transition.finally(() => {
    if (pulledReviewTransitions.get(feature) === transition) pulledReviewTransitions.delete(feature);
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
        const pulledReview = current.pulledReview;
        if (pulledReview) {
          if (pulledReview.codexTurnId && current.codexThreadId) {
            await interruptReview(current.codexThreadId, pulledReview.codexTurnId);
          }
          store.update(pair.feature, (value) => {
            if (value.pulledReview?.id === pulledReview.id) value.pulledReview = undefined;
          });
          log(`Discarded obsolete pulled review ${pulledReview.id} for checkpoint ${pendingId}.`);
        }
        if (supersededTurnId && current.codexThreadId) {
          await interruptReview(current.codexThreadId, supersededTurnId);
        }
        const latest = store.get(pair.feature);
        if (!latest?.pending || latest.pending.id !== pendingId) return;
        await startReview(latest, pendingId);
      } catch (error) {
        const current = store.get(pair.feature);
        if (!current?.pending || current.pending.id !== pendingId) return;
        if (isCodexThreadBusyError(error) || (current.codexThreadId && activeCodexThreads.has(current.codexThreadId))) {
          log(`Review ${pendingId} remains queued for ${pair.feature} until the active Codex turn completes.`);
          return;
        }
        log(`Review failed for ${pair.feature}: ${String(error)}`);
        sessionReports.complete(pair.feature, pendingId, undefined, {
          status: "failed",
          resolvedAt: new Date().toISOString(),
          note: error instanceof Error ? error.message : String(error)
        });
        store.update(pair.feature, (value) => {
          if (value.pending?.source === "pull-queue"
            && value.capturedClaudeMessage?.queueCheckpointId === pendingId) {
            value.capturedClaudeMessage.queueRequestedAt = undefined;
            value.capturedClaudeMessage.queueCheckpointId = undefined;
          }
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

function release(pendingId: string, result: Release): boolean {
  const waiter = waiters.get(pendingId);
  if (!waiter) return false;
  waiters.delete(pendingId);
  waiter.response.removeListener("close", waiter.onClose);
  waiter.resolve(result);
  return true;
}

async function finishReview(turn: CompletedTurn): Promise<void> {
  const pair = store.all().find((candidate) => candidate.pending?.codexTurnId === turn.turnId);
  if (!pair?.pending) return;
  const pendingId = pair.pending.id;
  const completion = reviewTurnCompletion(turn.status, turn.text);
  if (completion === "interrupted") {
    sessionReports.complete(pair.feature, pendingId, turn.text, {
      codexTurnId: turn.turnId,
      status: "interrupted",
      autoRound: undefined,
      resolvedAt: new Date().toISOString(),
      note: "Codex review was interrupted; the checkpoint was released without feedback."
    });
    store.update(pair.feature, (value) => {
      if (value.pending?.source === "pull-queue"
        && value.capturedClaudeMessage?.queueCheckpointId === pendingId) {
        value.capturedClaudeMessage.queueRequestedAt = undefined;
        value.capturedClaudeMessage.queueCheckpointId = undefined;
      }
      value.mode = modeAfterUserDecision(pair.mode);
      value.autoRound = 0;
      value.status = "idle";
      value.pending = undefined;
    });
    release(pendingId, { kind: "allow" });
    log(`Released interrupted review ${pendingId} for ${pair.feature}; mode is ${modeAfterUserDecision(pair.mode)}.`);
    return;
  }
  if (completion === "failed") {
    sessionReports.complete(pair.feature, pendingId, turn.text, {
      codexTurnId: turn.turnId,
      status: "failed",
      resolvedAt: new Date().toISOString(),
      note: `Codex turn ended with status ${turn.status}.`
    });
    store.update(pair.feature, (value) => {
      if (value.pending?.source === "pull-queue"
        && value.capturedClaudeMessage?.queueCheckpointId === pendingId) {
        value.capturedClaudeMessage.queueRequestedAt = undefined;
        value.capturedClaudeMessage.queueCheckpointId = undefined;
      }
      value.status = "failed";
      value.mode = "off";
      value.pending = undefined;
    });
    release(pendingId, { kind: "allow" });
    return;
  }

  if (pair.pending.deferDecision) {
    const report = sessionReports.complete(pair.feature, pendingId, turn.text, {
      codexTurnId: turn.turnId,
      status: "deferred",
      autoRound: undefined,
      resolvedAt: new Date().toISOString(),
      note: "Background work remains in flight; no feedback was sent to Claude."
    });
    store.update(pair.feature, (value) => {
      value.status = "waiting-claude";
      value.lastCodexResponse = turn.text;
      value.pending = undefined;
    });
    release(pendingId, { kind: "allow" });
    log(`Deferred interim checkpoint ${pendingId} for ${pair.feature} in ${report?.durationMs ?? 0}ms.`);
    return;
  }

  if (pair.mode !== "auto") {
    sessionReports.complete(pair.feature, pendingId, turn.text, {
      codexTurnId: turn.turnId,
      status: "waiting-user"
    });
    store.update(pair.feature, (value) => {
      value.status = "waiting-user";
      value.lastCodexResponse = turn.text;
      if (value.pending) value.pending.codexResponse = turn.text;
    });
    return;
  }

  const resolution = resolveAutoReview(pair, turn.text);
  if (resolution.kind === "pass") {
    const report = sessionReports.complete(pair.feature, pendingId, resolution.summary, {
      codexTurnId: turn.turnId,
      decision: pair.pending.autoDecision,
      status: "passed",
      resolvedAt: new Date().toISOString()
    });
    const systemMessage = buildAutoCycleStatus(pair.feature);
    store.update(pair.feature, (value) => {
      value.status = "passed";
      value.autoRound = 0;
      value.lastCodexResponse = turn.text;
      value.pending = undefined;
    });
    log(`Completed ${pair.feature} checkpoint ${pendingId} as pass in ${report?.durationMs ?? 0}ms.`);
    release(pendingId, { kind: "allow", systemMessage });
    return;
  }
  if (resolution.kind === "continue") {
    const delivery = planAutoDelivery("continue", waiters.has(pendingId));
    const report = sessionReports.complete(pair.feature, pendingId, resolution.summary, {
      codexTurnId: turn.turnId,
      decision: pair.pending.autoDecision,
      status: delivery.outcome,
      resolvedAt: delivery.clearPending ? new Date().toISOString() : undefined,
      delivery: delivery.clearPending ? "stop-hook" : undefined
    });
    const continuation = buildAutoContinuation(resolution.continuation);
    store.update(pair.feature, (value) => {
      value.status = delivery.status;
      value.autoRound += 1;
      value.lastCodexResponse = turn.text;
      if (delivery.clearPending) value.pending = undefined;
      else if (value.pending) {
        value.pending.codexResponse = continuation;
        value.pending.deliveryKind = "continuation";
      }
    });
    log(`Completed ${pair.feature} checkpoint ${pendingId} as pass_continue (${delivery.outcome}) in ${report?.durationMs ?? 0}ms.`);
    if (delivery.clearPending) release(pendingId, { kind: "continue", text: continuation });
    return;
  }
  if (resolution.kind === "revise") {
    const delivery = planAutoDelivery("revise", waiters.has(pendingId));
    const report = sessionReports.complete(pair.feature, pendingId, resolution.feedback, {
      codexTurnId: turn.turnId,
      decision: pair.pending.autoDecision,
      status: delivery.outcome,
      resolvedAt: new Date().toISOString(),
      delivery: delivery.queueForNextPrompt ? "next-prompt" : "stop-hook"
    });
    const feedback = buildPublishedFeedback(resolution.feedback);
    store.update(pair.feature, (value) => {
      value.status = delivery.status;
      value.autoRound += 1;
      value.lastCodexResponse = resolution.feedback;
      if (delivery.queueForNextPrompt) value.queuedClaudeContext = feedback;
      if (delivery.clearPending) value.pending = undefined;
    });
    log(`Completed ${pair.feature} checkpoint ${pendingId} as revise (${delivery.outcome}) in ${report?.durationMs ?? 0}ms.`);
    if (!delivery.queueForNextPrompt) release(pendingId, { kind: "feedback", text: feedback });
    return;
  }
  log(`Auto response requires user review: ${resolution.reason}.`);
  const report = sessionReports.complete(pair.feature, pendingId, resolution.response, {
    codexTurnId: turn.turnId,
    decision: pair.pending.autoDecision,
    status: "waiting-user",
    note: `Automatic review paused: ${resolution.reason}.`
  });
  store.update(pair.feature, (value) => {
    value.status = "waiting-user";
    value.lastCodexResponse = resolution.response;
    if (value.pending) value.pending.codexResponse = resolution.response;
  });
  log(`Completed ${pair.feature} checkpoint ${pendingId} awaiting user in ${report?.durationMs ?? 0}ms.`);
}

function finishQuestionAdvisory(turn: CompletedTurn): void {
  const pair = store.all().find((candidate) => candidate.activeQuestionAdvisory?.codexTurnId === turn.turnId);
  if (!pair?.activeQuestionAdvisory) return;
  const advisoryId = pair.activeQuestionAdvisory.id;
  store.update(pair.feature, (value) => { value.activeQuestionAdvisory = undefined; });
  log(`Question advisory ${advisoryId} for ${pair.feature} finished with status ${turn.status}.`);
}

function finishPulledReview(turn: CompletedTurn): void {
  const pair = store.all().find((candidate) => candidate.pulledReview?.codexTurnId === turn.turnId);
  if (!pair?.pulledReview) return;
  const pulled = pair.pulledReview;
  store.update(pair.feature, (value) => {
    if (value.pulledReview?.id !== pulled.id) return;
    if (value.capturedClaudeMessage?.id === pulled.capturedMessageId) {
      if (turn.status === "completed" && turn.text) {
        value.capturedClaudeMessage.reviewedAt = new Date().toISOString();
      } else {
        value.capturedClaudeMessage.reviewRequestedAt = undefined;
      }
    }
    value.pulledReview = undefined;
  });
  log(`Pulled review ${pulled.id} for ${pair.feature} finished with status ${turn.status}.`);
}

async function handleTurnCompleted(turn: CompletedTurn): Promise<void> {
  activeCodexThreads.delete(turn.threadId);
  await finishReview(turn);
  finishQuestionAdvisory(turn);
  finishPulledReview(turn);
  for (const pair of store.all()) {
    if (pair.codexThreadId !== turn.threadId) continue;
    if (pair.status === "reviewing" && pair.pending && !pair.pending.codexTurnId) {
      scheduleReview(pair, pair.pending.id);
    } else if (pair.pulledReview && !pair.pulledReview.codexTurnId) {
      schedulePulledReview(pair.feature);
    } else if (pair.questionAdvisoryQueue?.length) scheduleQuestionAdvisory(pair.feature);
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
    workstreamContext: pair.workstreamContext ? "[stored for replacement thread recovery]" : undefined,
    queuedClaudeContext: pair.queuedClaudeContext ? "[queued for Claude's next prompt]" : undefined,
    lastCodexResponse: pair.lastCodexResponse ? "[held by bridge]" : undefined,
    questionAdvisoryQueue: pair.questionAdvisoryQueue?.map((item) => ({ id: item.id, createdAt: item.createdAt })),
    activeQuestionAdvisory: pair.activeQuestionAdvisory ? {
      id: pair.activeQuestionAdvisory.id,
      createdAt: pair.activeQuestionAdvisory.createdAt,
      codexTurnId: pair.activeQuestionAdvisory.codexTurnId
    } : undefined,
    pulledReview: pair.pulledReview ? {
      id: pair.pulledReview.id,
      capturedMessageId: pair.pulledReview.capturedMessageId,
      createdAt: pair.pulledReview.createdAt,
      codexTurnId: pair.pulledReview.codexTurnId
    } : undefined,
    capturedClaudeMessage: pair.capturedClaudeMessage ? {
      id: pair.capturedClaudeMessage.id,
      claudeSessionId: pair.capturedClaudeMessage.claudeSessionId,
      capturedAt: pair.capturedClaudeMessage.capturedAt,
      reviewState: pair.capturedClaudeMessage.reviewedAt
        ? "completed"
        : pair.pulledReview?.capturedMessageId === pair.capturedClaudeMessage.id
          ? "queued-or-active"
          : pair.capturedClaudeMessage.reviewRequestedAt ? "consumed" : "available",
      queueState: pair.capturedClaudeMessage.queueRequestedAt ? "consumed" : "available"
    } : undefined,
    seenQuestionAdvisoryIds: pair.seenQuestionAdvisoryIds?.length ?? 0,
    pending: pair.pending ? {
      ...pair.pending,
      claudeMessage: "[held by bridge]",
      codexResponse: pair.pending.codexResponse ? "[held by bridge]" : undefined,
      autoContinuation: pair.pending.autoContinuation ? "[held by bridge]" : undefined,
      backgroundTasks: undefined,
      interim: Boolean(pair.pending.interim),
      backgroundTaskCount: pair.pending.backgroundTasks?.length ?? 0
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
    let pair = store.ensure(String(body.feature), String(body.projectRoot), readInstanceDefaultMode());
    pair = store.update(pair.feature, (value) => {
      migrateClaudeSessionLifecycle(value);
      value.claudeSessionId = String(body.sessionId || value.claudeSessionId || randomUUID());
    });
    return send(res, 200, publicPair(pair));
  }
  if (req.url === "/pair/codex" && req.method === "POST") {
    let pair = store.ensure(String(body.feature), String(body.projectRoot), readInstanceDefaultMode());
    pair = await ensureCodexThread(pair);
    send(res, 200, { ...publicPair(pair), appServerUrl });
    if (pair.pulledReview) schedulePulledReview(pair.feature);
    else scheduleQuestionAdvisory(pair.feature);
    return;
  }
  if (req.url === "/pairs" && req.method === "GET") return send(res, 200, store.all().map(publicPair));
  if (req.url === "/status" && req.method === "POST") {
    const pair = feature ? store.get(feature) : undefined;
    return pair ? send(res, 200, publicPair(pair)) : send(res, 404, { error: "unknown feature" });
  }
  if (req.url === "/report" && req.method === "POST") {
    if (!feature) return send(res, 400, { error: "feature required" });
    if (body.full !== undefined && typeof body.full !== "boolean") {
      return send(res, 400, { error: "full must be a boolean" });
    }
    const pair = store.get(feature);
    if (!pair) return send(res, 404, { error: "unknown feature" });
    return send(res, 200, {
      feature,
      startedAt: sessionReports.startedAt,
      report: sessionReports.render(
        feature,
        pair.displayName,
        body.full === true,
        pair.workstreamContext ?? pair.initialPrompt
      )
    });
  }
  if (req.url === "/auto-decision" && req.method === "POST") {
    if (!feature) return send(res, 400, { error: "feature required" });
    const existing = store.get(feature);
    if (!existing) return send(res, 404, { error: "unknown feature" });
    const decisionError = autoDecisionError(existing, body.checkpointId, body.decision, body.continuation);
    if (decisionError) return send(res, 409, { error: decisionError });
    store.update(feature, (value) => {
      if (value.pending) {
        value.pending.autoDecision = body.decision as AutoReviewDecision;
        value.pending.autoContinuation = body.decision === "pass_continue"
          ? String(body.continuation).trim()
          : undefined;
      }
    });
    sessionReports.update(feature, String(body.checkpointId), {
      decision: body.decision as AutoReviewDecision
    });
    return send(res, 200, {
      recorded: true,
      feature,
      checkpointId: body.checkpointId,
      decision: body.decision,
      continuationRecorded: body.decision === "pass_continue",
      message: "Decision recorded. Finish with the normal Markdown review; the bridge will act when the turn completes."
    });
  }
  if (req.url === "/defer" && req.method === "POST") {
    if (!feature) return send(res, 400, { error: "feature required" });
    const existing = store.get(feature);
    if (!existing) return send(res, 404, { error: "unknown feature" });
    const deferralError = checkpointDeferralError(existing, body.checkpointId);
    if (deferralError) return send(res, 409, { error: deferralError });
    store.update(feature, (value) => {
      if (value.pending) value.pending.deferDecision = true;
    });
    sessionReports.update(feature, String(body.checkpointId), {
      note: "Codex requested silent deferral while background work remains in flight."
    });
    return send(res, 200, {
      recorded: true,
      feature,
      checkpointId: body.checkpointId,
      disposition: "defer",
      message: "Deferral recorded. Finish with concise Markdown; the bridge will release this Stop without feedback when the turn completes."
    });
  }
  if (req.url === "/mode" && req.method === "POST") {
    if (!feature || !["off", "manual", "once", "auto"].includes(String(body.mode))) return send(res, 400, { error: "invalid feature or mode" });
    const mode = body.mode as BridgeMode;
    const roundLimitError = autoRoundLimitError(mode, body.roundLimit);
    if (roundLimitError) return send(res, 400, { error: roundLimitError });
    const existing = store.get(feature);
    const advisoryTurnId = mode === "off" ? existing?.activeQuestionAdvisory?.codexTurnId : undefined;
    if (mode === "off" && existing?.pending) {
      sessionReports.update(feature, existing.pending.id, {
        status: "released-mode-off",
        resolvedAt: new Date().toISOString(),
        note: "Checkpoint released because the bridge was switched off."
      });
    }
    const pair = store.update(feature, (value) => {
      if (mode === "off" && value.pending && value.pending.source !== "pull-queue") {
        value.capturedClaudeMessage = captureClaudeMessage(
          value.claudeSessionId ?? "unknown",
          value.pending.claudeMessage
        );
      }
      value.mode = mode;
      value.autoRound = 0;
      value.autoRoundLimit = autoRoundLimitForMode(mode, body.roundLimit as number | undefined);
      if (mode === "off") {
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
  if (req.url === "/pull-review" && req.method === "POST") {
    if (!feature) return send(res, 400, { error: "feature required" });
    const existing = store.get(feature);
    if (!existing) return send(res, 404, { error: "unknown feature" });
    const validationError = pullReviewError(existing);
    if (validationError) return send(res, 409, { error: validationError });
    const captured = existing.capturedClaudeMessage!;
    const pulledReview = createPulledReview(captured);
    const requestedAt = new Date().toISOString();
    const pair = store.update(feature, (value) => {
      if (value.capturedClaudeMessage?.id !== captured.id) return;
      value.capturedClaudeMessage.reviewRequestedAt = requestedAt;
      value.pulledReview = pulledReview;
    });
    const dispatch = pair.codexThreadId && activeCodexThreads.has(pair.codexThreadId) ? "queued" : "starting";
    send(res, 200, {
      accepted: true,
      feature,
      capturedMessageId: captured.id,
      pulledReviewId: pulledReview.id,
      dispatch,
      delivery: "reviewer-only"
    });
    schedulePulledReview(feature);
    return;
  }
  if (req.url === "/pull-queue" && req.method === "POST") {
    if (!feature) return send(res, 400, { error: "feature required" });
    const existing = store.get(feature);
    if (!existing) return send(res, 404, { error: "unknown feature" });
    const validationError = pullQueueError(existing);
    if (validationError) return send(res, 409, { error: validationError });
    const captured = existing.capturedClaudeMessage!;
    const pendingId = store.newPendingId();
    const checkpoint = createCheckpoint(existing, pendingId, captured.message, new Date().toISOString(), "pull-queue");
    const requestedAt = new Date().toISOString();
    const pair = store.update(feature, (value) => {
      if (value.capturedClaudeMessage?.id !== captured.id) return;
      value.capturedClaudeMessage.queueRequestedAt = requestedAt;
      value.capturedClaudeMessage.queueCheckpointId = pendingId;
      value.status = "reviewing";
      value.checkpointSequence = checkpoint.sequence;
      value.pending = checkpoint;
      value.questionAdvisoryQueue = undefined;
      value.lastCodexResponse = undefined;
    });
    sessionReports.start(pair, checkpoint);
    send(res, 200, {
      accepted: true,
      feature,
      mode: pair.mode,
      capturedMessageId: captured.id,
      checkpointId: pendingId,
      checkpointSequence: checkpoint.sequence,
      delivery: "next-prompt-if-feedback"
    });
    scheduleReview(pair, pendingId);
    return;
  }
  if (req.url === "/publish" && req.method === "POST") {
    if (!feature) return send(res, 400, { error: "feature required" });
    const existing = store.get(feature);
    if (!existing) return send(res, 404, { error: "unknown feature" });
    const decisionError = checkpointDecisionError(existing, body.checkpointId, true);
    if (decisionError) return send(res, 409, { error: decisionError });
    const continuationDelivery = existing.pending?.deliveryKind === "continuation";
    const review = String(
      body.feedback
      || (continuationDelivery ? existing.pending?.autoContinuation : existing.pending?.codexResponse)
      || ""
    ).trim();
    if (!review) return send(res, 409, { error: "no Codex response or custom feedback to publish" });
    const text = continuationDelivery ? buildAutoContinuation(review) : buildPublishedFeedback(review);
    const pendingId = existing.pending?.id;
    const delivery = pendingId && waiters.has(pendingId) ? "stop-hook" : "next-prompt";
    if (pendingId) {
      sessionReports.update(feature, pendingId, {
        status: "published",
        delivery,
        resolvedAt: new Date().toISOString()
      });
    }
    const pair = store.update(feature, (value) => {
      value.mode = modeAfterUserDecision(existing.mode);
      if (!continuationDelivery) value.autoRound = 0;
      value.status = "waiting-claude";
      value.pending = undefined;
      if (delivery === "next-prompt") value.queuedClaudeContext = text;
    });
    if (pendingId) release(pendingId, continuationDelivery ? { kind: "continue", text } : { kind: "feedback", text });
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
    if (pendingId) {
      sessionReports.update(feature, pendingId, {
        status: "cancelled",
        resolvedAt: new Date().toISOString()
      });
    }
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
    let context = pair.queuedClaudeContext;
    if (context) store.update(pair.feature, (value) => {
      value.queuedClaudeContext = undefined;
      value.status = value.mode === "manual" ? "waiting-claude" : "idle";
    });
    let current = store.get(pair.feature) ?? pair;
    if (!current.workstreamContext && input.prompt) {
      current = store.update(pair.feature, (value) => {
        value.workstreamContext = input.prompt;
        value.initialPrompt = undefined;
      });
    }
    if (current.codexThreadId && current.workstreamContext && current.workstreamContextThreadId !== current.codexThreadId) {
      await ensureCodexThread(current);
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
    if (!pair || !input.last_assistant_message) return send(res, 200, { kind: "allow" });
    if (pair.mode === "off") {
      store.update(pair.feature, (value) => {
        recordClaudeSession(value, input.session_id, true);
        value.status = "idle";
        value.capturedClaudeMessage = captureClaudeMessage(input.session_id, input.last_assistant_message!);
      });
      log(`Captured the latest off-mode Claude handoff for ${pair.feature}.`);
      return send(res, 200, { kind: "allow" });
    }
    const superseded = pair.pending;
    const supersededQueuedFeedback = Boolean(pair.queuedClaudeContext);
    const pendingId = store.newPendingId();
    const backgroundTasks = normalizeBackgroundTasks(input.background_tasks);
    const checkpoint = createCheckpoint(
      pair,
      pendingId,
      input.last_assistant_message,
      new Date().toISOString(),
      "stop",
      backgroundTasks
    );
    if (superseded) {
      sessionReports.update(pair.feature, superseded.id, {
        status: "superseded",
        resolvedAt: new Date().toISOString(),
        supersededBy: { id: checkpoint.id, sequence: checkpoint.sequence }
      });
    }
    const current = store.update(pair.feature, (value) => {
      recordClaudeSession(value, input.session_id, true);
      value.status = "reviewing";
      value.checkpointSequence = checkpoint.sequence;
      value.pending = checkpoint;
      value.queuedClaudeContext = undefined;
      value.questionAdvisoryQueue = undefined;
      value.lastCodexResponse = undefined;
      value.capturedClaudeMessage = undefined;
    });
    sessionReports.start(current, checkpoint);
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
      startedAt: brokerStartedAt
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
    appProxy?.close();
    app.close();
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
