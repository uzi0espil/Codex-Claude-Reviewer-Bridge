import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { TestContext } from "node:test";
import { StateStore } from "../store.js";
import { WorkLease } from "../types.js";
import { LeaseError, WorkLeases } from "../work-leases.js";

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-leases-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filename = path.join(root, "state.json");
  const store = new StateStore(filename);
  const launches = new Map(["a", "b", "c", "d"].map((feature) => [feature, randomUUID()]));
  for (const feature of launches.keys()) store.ensure(feature, root);
  let now = 10_000;
  const createManager = (state: StateStore) => {
    const manager = new WorkLeases(state, (feature) => launches.get(feature), () => now);
    t.after(() => manager.close());
    return manager;
  };
  const manager = createManager(store);
  const request = (feature: string, mode: WorkLease["mode"] = "shared") =>
    ({ feature, mode, name: "machine-load", minutes: 1, generation: launches.get(feature)!, requestId: randomUUID() });
  const requestLease = (input: ReturnType<typeof request>, wait = false) => {
    const response: (WorkLease | LeaseError)[] = [];
    const cancel = manager.acquire(input, wait, (result) => response.push(result));
    return { response, cancel };
  };
  const release = (lease: WorkLease) => manager.operate(lease.feature, lease.name, lease.id, "release");
  return { store, filename, manager, request, requestLease, release, launches, createManager, advance: (ms: number) => { now += ms; } };
}

test("shared holders coexist and queued exclusive work takes precedence", (t) => {
  const { manager, request, requestLease, release, advance } = fixture(t);
  const [a] = requestLease(request("a")).response as WorkLease[];
  const [b] = requestLease(request("b")).response as WorkLease[];
  const timed = requestLease(request("c", "exclusive"), true).response;
  const late = requestLease(request("d"), true).response;
  assert.deepEqual(manager.active().map(({ feature }) => feature), ["a", "b"]);
  release(a);
  assert.deepEqual(timed, []);
  assert.deepEqual(late, []);
  advance(10_000);
  release(b);
  const [exclusive] = timed as WorkLease[];
  assert.equal(exclusive.mode, "exclusive");
  assert.equal(Date.parse(exclusive.grantedAt), 20_000);
  assert.equal(Date.parse(exclusive.expiresAt), 80_000);
  assert.deepEqual(late, []);
  release(exclusive);
  assert.equal((late[0] as WorkLease).feature, "d");
});

test("cancelled waiters leave the queue and stale releases cannot clear a replacement", (t) => {
  const { manager, request, requestLease, release } = fixture(t);
  const first = request("a");
  const [original] = requestLease(first).response as WorkLease[];
  assert.deepEqual(requestLease(first).response, [original], "retry returns the original grant");
  const waiting = requestLease(request("b", "exclusive"), true);
  assert.throws(() => requestLease(request("c")), /busy/);
  waiting.cancel();
  const [shared] = requestLease(request("c")).response as WorkLease[];
  assert.equal(shared.feature, "c");
  release(original);
  const [replacement] = requestLease(request("a")).response as WorkLease[];
  assert.throws(() => release(original), /no longer held/);
  assert.equal(manager.active().find(({ feature }) => feature === "a")?.id, replacement.id);
  assert.deepEqual(waiting.response, []);
});

test("expiry and launcher replacement release ordinary grants and preserve evidence", (t) => {
  const { store, manager, request, requestLease, launches, advance } = fixture(t);
  requestLease(request("a"));
  advance(5_000);
  requestLease(request("b"));
  advance(55_000);
  launches.set("b", randomUUID());
  manager.tick();
  assert.deepEqual(manager.active(), []);
  assert.deepEqual(manager.evidence(store.get("a")!)?.history.map(({ type }) => type), ["lease-granted", "lease-expired"]);
  assert.deepEqual(manager.evidence(store.get("b")!)?.history.map(({ type }) => type), ["lease-granted", "lease-owner-exited"]);
});

test("restart restores the grant and keeps expired managed work blocked pending cleanup", (t) => {
  const { filename, manager, request, requestLease, createManager, advance } = fixture(t);
  const [lease] = requestLease(request("a", "exclusive")).response as WorkLease[];
  manager.operate("a", lease.name, lease.id, "arm");
  const waiting = requestLease(request("b"), true).response;
  manager.close();
  assert.equal((waiting[0] as LeaseError).status, 503);
  const disk = new StateStore(filename);
  const restarted = createManager(disk);
  restarted.start();
  assert.equal(restarted.active()[0].id, lease.id);
  assert.deepEqual(restarted.evidence(disk.get("a")!)?.history.map(({ type }) => type), [
    "lease-granted", "lease-armed", "lease-restored"
  ]);
  advance(60_000);
  restarted.tick();
  assert.equal(restarted.active()[0].draining, "expired");
  assert.throws(() => restarted.acquire(request("b"), false, () => {}), /busy/);
  restarted.operate("a", lease.name, lease.id, "release");
  assert.deepEqual(restarted.active(), []);
});
