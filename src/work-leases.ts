import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { runtimeDirectory } from "./paths.js";
import { StateStore } from "./store.js";
import { FeaturePair, PairTransition, StoredWorkLease, WorkLease } from "./types.js";

export const defaultLeaseMinutes = 30;
export const maxLeaseMinutes = 1440;

export function readLiveLaunch(feature: string): string | undefined {
  const key = createHash("sha256").update(feature).digest("hex");
  try {
    const owner = JSON.parse(fs.readFileSync(path.join(runtimeDirectory, "launches", `${key}-claude.lock`, "owner.json"), "utf8"));
    if (typeof owner.generation !== "string" || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 ||
        !(Date.parse(owner.createdAt) >= Date.now() - os.uptime() * 1000 - 60_000)) return;
    try { process.kill(owner.pid, 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") return;
    }
    return owner.generation;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

export function publicLease({ generation, requestId, ...lease }: StoredWorkLease): WorkLease {
  return lease;
}

export class LeaseError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

interface Request {
  feature: string;
  generation: string;
  requestId: string;
  name: string;
  mode: WorkLease["mode"];
  minutes: number;
}

type Waiter = Request & { finish: (result: WorkLease | LeaseError) => void };

export class WorkLeases {
  private queue: Waiter[] = [];
  private timer?: NodeJS.Timeout;
  private closed = false;

  constructor(private store: StateStore, private liveLaunch = readLiveLaunch,
    private now = Date.now, private onError: (error: unknown) => void = console.error) {}

  start(): void {
    this.tick();
    for (const lease of this.held()) {
      this.record(lease, "lease-restored", lease);
    }
    this.timer = setInterval(() => {
      try { this.tick(); } catch (error) { this.onError(error); }
    }, 500).unref();
  }

  close(): void {
    this.closed = true;
    clearInterval(this.timer);
    for (const waiter of this.queue.splice(0)) waiter.finish(new LeaseError(503, "Broker is restarting."));
  }

  private held(): StoredWorkLease[] {
    return this.store.all().flatMap((pair) => pair.workLeases ?? []);
  }

  private record(lease: StoredWorkLease, type: PairTransition["type"], replacement?: StoredWorkLease): void {
    const pair = this.store.get(lease.feature)!;
    const leases = (pair.workLeases ?? []).filter(({ id }) => id !== lease.id);
    if (replacement) leases.push(replacement);
    this.store.setWorkLeases(pair, leases, { type, lease: publicLease(replacement ?? lease) });
  }

  active(pair?: FeaturePair): WorkLease[] {
    return (pair ? pair.workLeases ?? [] : this.held()).map(publicLease);
  }

  evidence(pair: FeaturePair): NonNullable<FeaturePair["pending"]>["leaseEvidence"] {
    if (!pair.workLeases) return;
    const active = this.active(pair);
    const history = (pair.events ?? []).filter((event) => event.lease);
    return { active, history: history.slice(-32),
      historyMayBeIncomplete: history.length > 32 || (pair.events?.[0]?.sequence ?? 1) > 1 };
  }

  acquire(request: Request, wait: boolean, finish: Waiter["finish"]): () => void {
    if (this.closed) throw new LeaseError(503, "Broker is restarting.");
    this.tick();
    if (this.liveLaunch(request.feature) !== request.generation) throw new LeaseError(409, "The Claude launch for this feature has ended or changed.");
    const existing = this.held().find((lease) => lease.feature === request.feature && lease.name === request.name);
    if (existing) {
      if (existing.requestId !== request.requestId || existing.generation !== request.generation ||
          existing.mode !== request.mode || existing.draining) throw new LeaseError(409, "This pair already holds or is cleaning up that lease.");
      finish(publicLease(existing));
      return () => {};
    }
    const index = this.queue.findIndex((item) => item.feature === request.feature && item.name === request.name);
    if (index !== -1 && this.queue[index].requestId !== request.requestId) throw new LeaseError(409, "This pair is already waiting for that lease.");
    if (!wait && (this.queue.some((item) => item.name === request.name) || !this.compatible(request))) {
      throw new LeaseError(409, "Lease is busy.");
    }
    if (index === -1 && this.queue.length >= 256) throw new LeaseError(503, "Lease wait queue is full.");
    const waiter = { ...request, finish };
    if (index === -1) this.queue.push(waiter);
    else {
      const previous = this.queue[index];
      this.queue[index] = waiter;
      previous.finish(new LeaseError(503, "Lease wait reconnected."));
    }
    const cancel = () => { this.queue = this.queue.filter((item) => item !== waiter); };
    try { this.tick(); } catch (error) { cancel(); throw error; }
    return cancel;
  }

  private compatible(request: Request): boolean {
    return !this.held().some((lease) => lease.name === request.name &&
      (lease.draining || lease.mode === "exclusive" || request.mode === "exclusive"));
  }

  tick(): void {
    if (this.closed) return;
    const now = this.now();
    for (const lease of this.held()) {
      if (lease.draining) continue;
      const reason = Date.parse(lease.expiresAt) <= now ? "expired"
        : this.liveLaunch(lease.feature) !== lease.generation ? "owner-exited" : undefined;
      if (!reason) continue;
      if (lease.managed) this.record(lease, "lease-draining", { ...lease, draining: reason });
      else this.record(lease, reason === "expired" ? "lease-expired" : "lease-owner-exited");
    }
    const blocked = new Set<string>();
    for (const waiter of [...this.queue]) {
      if (this.liveLaunch(waiter.feature) !== waiter.generation) {
        this.dequeue(waiter, new LeaseError(409, "The Claude launch for this feature has ended or changed."));
      } else if (blocked.has(waiter.name) || !this.compatible(waiter)) {
        blocked.add(waiter.name);
      } else {
        const grantTime = this.now();
        const lease: StoredWorkLease = {
          id: randomUUID(), name: waiter.name, feature: waiter.feature, generation: waiter.generation,
          requestId: waiter.requestId, mode: waiter.mode, grantedAt: new Date(grantTime).toISOString(),
          expiresAt: new Date(grantTime + waiter.minutes * 60_000).toISOString()
        };
        this.record(lease, "lease-granted", lease);
        this.dequeue(waiter, publicLease(lease));
      }
    }
  }

  private dequeue(waiter: Waiter, result: WorkLease | LeaseError): void {
    this.queue = this.queue.filter((item) => item !== waiter);
    waiter.finish(result);
  }

  operate(feature: string, name: string, id: string, action: "arm" | "release" | "check"): WorkLease {
    if (this.closed) throw new LeaseError(503, "Broker is restarting.");
    this.tick();
    const lease = this.store.get(feature)?.workLeases?.find((item) => item.name === name && item.id === id);
    if (!lease) throw new LeaseError(404, "Matching lease is no longer held.");
    if (action !== "release" && lease.draining) throw new LeaseError(409, "The lease has ended and cleanup is required.");
    if (action === "arm" && !lease.managed) {
      const armed = { ...lease, managed: true };
      this.record(lease, "lease-armed", armed);
      return publicLease(armed);
    }
    if (action === "release") {
      this.record(lease, "lease-released");
      this.tick();
    }
    return publicLease(lease);
  }
}
