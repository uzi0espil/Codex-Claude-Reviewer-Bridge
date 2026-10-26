import { ContextEvent, ContextJournal, contextBatch } from "./context-journal.js";
import { StateStore } from "./store.js";
import { FeaturePair } from "./types.js";
import { isUsageLimit, retryDeadline, usageResetAt } from "./usage-limit.js";

export function reviewsSuspended(pair: FeaturePair): boolean {
  return pair.activity === "standby" || pair.activity === "catching-up";
}

export interface StandbyHost {
  ensureThread(pair: FeaturePair): Promise<FeaturePair>;
  busy(threadId: string): boolean;
  inject(threadId: string, text: string): Promise<void>;
  interrupt(threadId: string, turnId: string): Promise<void>;
  release(checkpointId: string): void;
  report(feature: string, checkpointId: string): void;
  review(pair: FeaturePair, handoff: ContextEvent): void;
  rateLimits(): Promise<unknown>;
  notify(kind: "standby" | "recovered", name: string): void;
}

export class StandbyController {
  private jobs = new Map<string, Promise<void>>();
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(readonly store: StateStore, readonly journal: ContextJournal, private host: StandbyHost) {}

  capture(pair: FeaturePair, event: Omit<ContextEvent, "sequence" | "id" | "createdAt">): void {
    if (pair.mode !== "auto") return;
    try {
      this.history(pair);
      const parts = this.journal.append(pair.feature, event);
      this.store.update(pair.feature, (value) => { value.contextSequence = Math.max(value.contextSequence ?? 0, parts.at(-1)!.sequence); });
    } catch {
      this.store.update(pair.feature, (value) => { value.contextGap = true; });
      this.enter(pair.feature, "capture-gap");
    }
  }

  history(pair: FeaturePair): ContextEvent[] {
    const history = this.journal.read(pair.feature);
    if (Math.max(pair.contextCursor ?? 0, pair.contextSequence ?? 0) > history.length) throw new Error("Context journal is missing captured history.");
    return history;
  }

  enter(feature: string, reason: NonNullable<FeaturePair["standby"]>["reason"]): void {
    const pair = this.store.get(feature)!;
    if (pair.mode !== "auto") return;
    if (pair.activity === "standby" && pair.standby?.reason === reason) return;
    const pending = pair.pending;
    const turnIds = [pending?.codexTurnId, pair.activeQuestionAdvisory?.codexTurnId, pair.pulledReview?.codexTurnId];
    // Capture legacy checkpoints too, including ones created before journaling.
    if (pending) this.captureLegacy(pair, "handoff", pending.claudeMessage, `checkpoint:${pending.id}`, pending.backgroundTasks);
    if (pair.queuedClaudeContext || pending?.codexResponse) {
      this.captureLegacy(pair, "feedback", pair.queuedClaudeContext ?? pending!.codexResponse!);
    }
    this.cancelTimer(feature);
    const wasStandby = pair.activity === "standby" || pair.activity === "catching-up";
    this.store.update(feature, (value) => {
      value.activity = "standby";
      value.recoveryNeeded = true;
      if (pending) {
        try {
          const lastHandoff = this.history(value).filter((event) => event.kind === "handoff").at(-1);
          if (lastHandoff) value.recoveryHandoffSequence = Math.min(value.recoveryHandoffSequence ?? 0, lastHandoff.sequence - 1);
        } catch { value.contextGap = true; }
      }
      value.standby = { reason, enteredAt: new Date().toISOString(),
        generation: (value.standby?.generation ?? 0) + 1,
        attempts: reason === "usage-limit" ? value.standby?.attempts ?? 0 : 0 };
      value.status = "idle";
      value.pending = undefined;
      value.queuedClaudeContext = undefined;
      value.activeQuestionAdvisory = undefined;
      value.questionAdvisoryQueue = undefined;
      value.pulledReview = undefined;
    });
    if (pending) {
      this.host.report(feature, pending.id);
      this.host.release(pending.id);
    }
    for (const turn of turnIds) if (turn && pair.codexThreadId) void this.host.interrupt(pair.codexThreadId, turn);
    if (!wasStandby) this.host.notify("standby", pair.displayName);
  }

  private captureLegacy(pair: FeaturePair, kind: ContextEvent["kind"], content: string, sourceId?: string, backgroundTasks?: ContextEvent["backgroundTasks"]): void {
    try {
      if (kind === "handoff") {
        const history = this.history(pair);
        const last = history.filter((item) => item.kind === "handoff").at(-1);
        if (last) {
          const whole = history.filter((item) => item.id.split(":")[0] === last.id.split(":")[0]).map((item) => item.content).join("");
          if (whole === content) return;
        }
      }
      const parts = this.journal.append(pair.feature, { kind, content, sessionId: pair.claudeSessionId ?? "unknown", sourceId, backgroundTasks });
      this.store.update(pair.feature, (value) => { value.contextSequence = Math.max(value.contextSequence ?? 0, parts.at(-1)!.sequence); });
    }
    catch { this.store.update(pair.feature, (value) => { value.contextGap = true; }); }
  }

  async exhausted(feature: string, error: unknown): Promise<boolean> {
    const pair = this.store.get(feature);
    if (!pair || pair.mode !== "auto" || !isUsageLimit(error)) return false;
    // Respect manual standby that happened while a failing RPC was in flight.
    if (pair.activity === "standby" && pair.standby?.reason === "user-requested") return true;
    this.enter(feature, "usage-limit");
    const generation = pair.standby!.generation;
    let reset: number | undefined;
    let timer: NodeJS.Timeout | undefined;
    try {
      reset = usageResetAt(await Promise.race([
        this.host.rateLimits(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Rate-limit snapshot unavailable.")), 5_000); })
      ]));
    } catch { /* manual recovery remains available */ }
    finally { clearTimeout(timer); }
    if (pair.standby?.generation !== generation || pair.standby.reason !== "usage-limit" || pair.mode !== "auto") return true;
    const deadline = retryDeadline(reset, pair.standby.attempts);
    if (deadline !== undefined) {
      this.store.update(feature, (value) => { value.standby!.nextRetryAt = new Date(deadline).toISOString(); });
      this.armRetry(pair);
    }
    return true;
  }

  cancelTimer(feature: string): void {
    clearTimeout(this.timers.get(feature));
    this.timers.delete(feature);
  }

  armRetry(pair: FeaturePair): void {
    this.cancelTimer(pair.feature);
    if (pair.mode !== "auto" || pair.activity !== "standby" || pair.standby?.reason !== "usage-limit" || !pair.standby.nextRetryAt) return;
    const generation = pair.standby.generation;
    const delay = Date.parse(pair.standby.nextRetryAt) - Date.now();
    if (!Number.isFinite(delay)) return;
    this.timers.set(pair.feature, setTimeout(() => {
      const current = this.store.get(pair.feature)!;
      if (current.standby?.generation !== generation || current.mode !== "auto" || current.activity !== "standby") return;
      if (Date.parse(current.standby.nextRetryAt!) > Date.now()) { this.armRetry(current); return; }
      this.store.update(current.feature, (value) => { value.standby!.attempts++; });
      this.resume(current.feature);
    }, Math.max(1, Math.min(delay, 2_147_000_000))).unref());
  }

  resume(feature: string): void {
    const pair = this.store.get(feature)!;
    if (pair.mode !== "auto") throw new Error("Resume requires auto mode.");
    if (pair.contextGap) throw new Error("Context capture has a gap. Inspect and repair the journal before resuming.");
    this.history(pair); // fail before changing state on corrupt/missing history
    if (pair.activity !== "standby" && pair.activity !== "catching-up") return;
    this.cancelTimer(feature);
    if (pair.activity === "standby") this.store.update(feature, (value) => {
      value.activity = "catching-up";
      value.standby!.nextRetryAt = undefined;
      value.standby!.generation++;
    });
    this.dispatch(feature);
  }

  dispatch(feature: string): void {
    if (this.jobs.has(feature)) return;
    const job = this.catchUp(feature).catch(async (error) => {
      const pair = this.store.get(feature)!;
      if (pair.activity !== "catching-up") return;
      if (await this.exhausted(feature, error)) return;
      this.enter(feature, "recovery-failed");
    });
    this.jobs.set(feature, job);
    void job.finally(() => { this.jobs.delete(feature); });
  }

  async deliver(pair: FeaturePair, valid: () => boolean): Promise<boolean> {
    const thread = pair.codexThreadId!;
    const history = this.history(pair);
    if (pair.contextThreadId !== thread) this.store.update(pair.feature, (value) => {
      value.contextThreadId = thread; value.contextCursor = 0;
    });
    // Each pass has a fixed snapshot; events arriving during injection stay pending.
    for (const event of history.filter((item) => item.sequence > (pair.contextCursor ?? 0))) {
      if (!valid() || this.host.busy(thread)) return false;
      await this.host.inject(thread, contextBatch(event));
      if (!valid() || pair.codexThreadId !== thread) return false;
      this.store.update(pair.feature, (value) => { value.contextCursor = event.sequence; });
    }
    return valid();
  }

  private async catchUp(feature: string): Promise<void> {
    let pair = this.store.get(feature)!;
    const generation = pair.standby?.generation;
    const valid = () => pair.activity === "catching-up" && pair.mode === "auto" && pair.standby?.generation === generation;
    if (!valid() || (pair.codexThreadId && this.host.busy(pair.codexThreadId))) return;
    pair = await this.host.ensureThread(pair);
    if (!valid()) return;
    if (!await this.deliver(pair, valid)) return;
    const history = this.history(pair);
    if ((pair.contextCursor ?? 0) < history.length) {
      // Yield to hooks and bound work per dispatch while preserving all events.
      setImmediate(() => this.dispatch(feature));
      return;
    }
    const handoffs = history.filter((item) => item.kind === "handoff" && item.sequence > (pair.recoveryHandoffSequence ?? 0));
    const last = handoffs.at(-1);
    // Reassemble split handoffs for the checkpoint; context batches stay bounded.
    const handoff = last ? { ...last, content: history.filter((item) => item.id.split(":")[0] === last.id.split(":")[0]).map((item) => item.content).join("") } : undefined;
    this.store.update(feature, (value) => {
      value.activity = "active";
      value.recoveryNeeded = false;
    });
    if (handoff) this.host.review(pair, handoff);
    else {
      this.host.notify("recovered", pair.displayName);
      this.store.update(feature, (value) => { value.standby = undefined; });
    }
  }

  close(): void {
    for (const feature of this.timers.keys()) this.cancelTimer(feature);
  }
}
