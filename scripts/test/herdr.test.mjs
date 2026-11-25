import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { chooseTerminal, validatedTerminal, needsHerdrServer } from "../reviewer.mjs";
import { herdrServerSpec, launchHerdrServer, herdrPairSpecs, launchHerdrPair, nameHerdrWorkspace, reportStatus, statusRelay } from "../herdr.mjs";

test("terminal choices normalize aliases and retain the platform default", async () => {
  assert.equal(validatedTerminal(), "auto");
  assert.equal(validatedTerminal("herder"), "herdr");
  assert.throws(() => validatedTerminal("custom"), /Terminal must/);
  assert.equal(await chooseTerminal(undefined, undefined, { isTTY: false }, {}), "auto");
  assert.equal(await chooseTerminal(undefined, "herdr", {}, {}), "herdr");
  assert.equal(await chooseTerminal("auto", "herdr", {}, {}), "auto");
  const input = new PassThrough(); input.isTTY = true;
  const output = new PassThrough(); output.isTTY = true;
  const selected = chooseTerminal(undefined, undefined, input, output);
  input.write("2\n");
  assert.equal(await selected, "herdr");
  input.end(); output.end();
});

const options = {
  executable: "hc", root: "/reviewer's home", projectRoot: "/my project", instanceId: "instance-a",
  feature: "don't flatten this", coderArgs: ["start-coder", "--feature", "don't flatten this", "--", "--model", "opus"],
  reviewerArgs: ["start-reviewer", "--feature", "don't flatten this"]
};

test("shared servers use independent instance-scoped terminals rather than feature spaces", () => {
  const spec = herdrServerSpec(options);
  for (const flag of ["--bg", "--no-parent", "--outlive-parent"]) assert.ok(spec.args.includes(flag));
  assert.ok(!spec.args.includes("--keep"));
  assert.deepEqual(spec.args.slice(-3), ["--", process.execPath, path.join(options.root, "dist", "broker.js")]);
  assert.deepEqual(herdrServerSpec({ ...options, feature: "another feature" }), spec);
  assert.notDeepEqual(herdrServerSpec({ ...options, instanceId: "other-instance" }), spec);
  assert.notEqual(spec.args.find((arg) => arg.startsWith("herdr.space=")), herdrPairSpecs(options)[0].args.find((arg) => arg.startsWith("herdr.space=")));
  assert.equal(needsHerdrServer("herdr", {}), true);
  assert.equal(needsHerdrServer("auto", { HC_TERMINAL_ID: "t1" }), true);
  assert.equal(needsHerdrServer("auto", { REVIEW_BRIDGE_TERMINAL: "herdr" }), true);
  assert.equal(needsHerdrServer("auto", {}), false);
});

test("server startup reuses a live terminal and never falls back after an uncertain launch", async () => {
  const spec = herdrServerSpec(options);
  const name = spec.args[spec.args.indexOf("--name") + 1];
  let terminals = [], launches = 0;
  const run = (_, args) => {
    if (args.includes("--help")) return { stdout: "--bg --no-parent --outlive-parent --label" };
    if (args[0] === "ls") return { stdout: JSON.stringify({ terminals }) };
    if (args[0] === "keep") { assert.deepEqual(args, ["keep", "t-server", "--off"]); return { stdout: '{}' }; }
    launches++;
    assert.deepEqual(args, spec.args);
    terminals = [{ state: "live", address: "t-server", name }];
    throw new Error("lost reply");
  };
  await assert.rejects(launchHerdrServer({ ...options, run }), /no in-terminal fallback/);
  assert.equal(await launchHerdrServer({ ...options, run, warn: () => {} }), "t-server");
  assert.equal(launches, 1);
  await assert.rejects(launchHerdrServer({ ...options, executable: undefined }), /requires hc/);
  await assert.rejects(launchHerdrServer({ ...options, run: () => ({ stdout: "--bg --no-parent --label" }) }), /Update hc/);
});

test("pair terminals never launch when independent server startup fails", async () => {
  let launches = 0;
  await assert.rejects(launchHerdrPair({ ...options,
    run: (_, args) => {
      if (args.includes("--help")) return { stdout: "--bg --no-parent --label --keep" };
      if (args[0] === "ls") return { stdout: '{"terminals":[]}' };
      launches++;
      return { stdout: '{"address":"unexpected"}' };
    },
    ensureServer: async () => { throw new Error("server unavailable"); }
  }), /server unavailable/);
  assert.equal(launches, 0);
});

test("hc launches labelled independent terminals with intact bridge arguments", () => {
  const specs = herdrPairSpecs(options);
  for (const [index, spec] of specs.entries()) {
    assert.equal(spec.command, "hc");
    assert.ok(spec.args.includes("--no-parent"));
    assert.ok(spec.args.includes("--bg"));
    assert.ok(spec.args.includes("--keep"));
    assert.ok(spec.args.includes("/my project"));
    assert.deepEqual(JSON.parse(Buffer.from(spec.args.at(-1), "base64")), index ? options.reviewerArgs : options.coderArgs);
  }
  assert.equal(specs[0].args.filter((arg) => arg.startsWith("herdr.space="))[0], specs[1].args.filter((arg) => arg.startsWith("herdr.space="))[0]);
  assert.notDeepEqual(herdrPairSpecs({ ...options, instanceId: "instance-b" }), specs);
  const workspace = (values) => values[0].args.find((arg) => arg.startsWith("herdr.space="));
  assert.notEqual(workspace(herdrPairSpecs({ ...options, feature: "another feature" })), workspace(specs));
});

test("names the adopted workspace after the exact feature without restarting terminals", async () => {
  const calls = [];
  const feature = "feature with spaces and 'quotes'";
  const run = (command, args) => {
    calls.push({ command, args });
    if (args[0] === "ls") return { stdout: JSON.stringify({ spaces: [{ id: "workspace-id", name: "application", tabs: [{ terminals: [{ terminal: "t1" }, { terminal: "t2" }] }] }] }) };
    return { stdout: '{"ok":true}' };
  };
  await nameHerdrWorkspace({ appExecutable: "herdr-app", run, feature, addresses: ["t1", "t2"] });
  assert.deepEqual(calls, [
    { command: "herdr-app", args: ["ls"] },
    { command: "herdr-app", args: ["do", "space.rename", "--id", "workspace-id", "--name", feature] }
  ]);
});

test("waits for desktop adoption and leaves an already named workspace alone", async () => {
  let reads = 0;
  await nameHerdrWorkspace({
    appExecutable: "herdr-app", feature: "my-feature", addresses: ["t1", "t2"], attempts: 2,
    run: (_, args) => {
      assert.deepEqual(args, ["ls"]);
      reads++;
      return { stdout: JSON.stringify({ spaces: reads === 1 ? [] : [{ id: "space", name: "my-feature", tabs: [{ terminals: [{ terminal: "t1" }, { terminal: "t2" }] }] }] }) };
    }
  });
  assert.equal(reads, 2);
});

test("naming failures warn without relaunching or renaming an unrelated workspace", async () => {
  const warnings = [];
  const warn = (message) => warnings.push(message);
  await nameHerdrWorkspace({ warn });
  await nameHerdrWorkspace({ appExecutable: "herdr-app", warn, run: () => { throw new Error("app is closed"); } });
  await nameHerdrWorkspace({
    appExecutable: "herdr-app", warn, feature: "my-feature", addresses: ["t1", "t2"], attempts: 1,
    run: (_, args) => {
      assert.deepEqual(args, ["ls"]);
      return { stdout: JSON.stringify({ spaces: [{ id: "shared", tabs: [{ terminals: [{ terminal: "t1" }, { terminal: "t2" }] }, { terminals: [{ terminal: "other-feature" }] }] }] }) };
    }
  });
  assert.match(warnings[0], /herdr-app on PATH/);
  assert.match(warnings[1], /app is closed/);
  assert.match(warnings[2], /shared by other features/);
});

test("missing and incompatible hc fall back with a warning", async () => {
  const warnings = [];
  const warn = (message) => warnings.push(message);
  assert.equal(await launchHerdrPair({ ...options, executable: undefined, platform: "win32", warn }), false);
  assert.match(warnings[0], /hc was not found.*Windows Terminal.*unchanged/);
  assert.equal(await launchHerdrPair({ ...options, run: () => ({ stdout: "old CLI" }), warn }), false);
  assert.match(warnings[1], /lacks required/);
  assert.equal(await launchHerdrPair({ ...options, run: () => { throw new Error("offline"); }, warn }), false);
});

test("launch failure avoids fallback and retry reuses a partially started pair", async () => {
  const calls = [];
  const specs = herdrPairSpecs(options);
  const name = specs[0].args[specs[0].args.indexOf("--name") + 1];
  let terminals = [];
  const run = (_, args) => {
    if (args.includes("--help")) return { stdout: "--bg --no-parent --label --keep" };
    if (args[0] === "ls") return { stdout: JSON.stringify({ terminals }) };
    calls.push(args);
    if (calls.length === 1) { terminals = [{ state: "live", address: "t1", name }]; return { stdout: '{"address":"t1"}' }; }
    if (calls.length === 2) throw new Error("lost response");
    return { stdout: '{"address":"t2"}' };
  };
  await assert.rejects(launchHerdrPair({ ...options, run }), /fallback was skipped.*duplicate/);
  assert.equal(await launchHerdrPair({ ...options, run }), true);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[2], specs[1].args);
});

test("the hc child entrypoint can import its own status helpers without an ESM await cycle", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-child-"));
  const directory = path.join(fixture, "real");
  const alias = path.join(fixture, "alias");
  try {
    fs.mkdirSync(directory);
    fs.symlinkSync(directory, alias, process.platform === "win32" ? "junction" : "dir");
    fs.copyFileSync(new URL("../herdr.mjs", import.meta.url), path.join(directory, "herdr.mjs"));
    fs.writeFileSync(path.join(directory, "reviewer.mjs"), 'export async function main(args) { const { reportStatus } = await import("./herdr.mjs"); reportStatus("codex", "idle"); console.log(JSON.stringify(args)); }');
    const args = ["start-reviewer", "--feature", "a'b"];
    for (const entryDirectory of [directory, alias]) {
      const result = spawnSync(process.execPath, [path.join(entryDirectory, "herdr.mjs"), "child", Buffer.from(JSON.stringify(args)).toString("base64")], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      assert.ok(result.stdout.includes(JSON.stringify(args)), `No child output through ${entryDirectory}: ${result.stderr}`);
      assert.match(result.stdout, /7501;state=idle:app=codex/);
    }
  } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
});

test("Codex status relay forwards RPC unchanged and reports injected turns and approvals", async () => {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstream, "listening");
  const states = [];
  const relay = await statusRelay(`ws://127.0.0.1:${upstream.address().port}`, (state) => states.push(state));
  const connected = once(upstream, "connection");
  const client = new WebSocket(relay.url);
  try {
    await once(client, "open");
    const [server] = await connected;
    const send = async (message) => {
      const received = once(client, "message");
      server.send(JSON.stringify(message));
      assert.deepEqual(JSON.parse(String((await received)[0])), message);
    };
    await send({ method: "turn/started", params: { turn: { id: "injected" } } });
    await send({ id: -1, method: "item/commandExecution/requestApproval", params: { command: "test" } });
    assert.deepEqual(states, ["working", "blocked"]);
    const response = once(server, "message");
    client.send('{"id":-1,"result":{"decision":"accept"}}');
    assert.equal(String((await response)[0]), '{"id":-1,"result":{"decision":"accept"}}');
    await send({ method: "turn/completed", params: { turn: { status: "completed" } } });
    await send({ method: "turn/completed", params: { turn: { status: "failed" } } });
    assert.deepEqual(states, ["working", "blocked", "working", "done", "error"]);
    let output = "";
    reportStatus("codex", "working", { write: (text) => { output += text; } });
    assert.equal(output, "\x1b]7501;state=working:app=codex\x1b\\");
  } finally {
    client.terminate(); relay.close();
    for (const socket of upstream.clients) socket.terminate();
    upstream.close();
  }
});
