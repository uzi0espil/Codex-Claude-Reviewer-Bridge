import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";

const filename = fileURLToPath(import.meta.url);

export function reportStatus(app, state, output = process.stdout) {
  output.write(`\x1b]7501;state=${state}:app=${app}\x1b\\`);
}

export function herdrPairSpecs({ executable, root, projectRoot, instanceId, feature, coderArgs, reviewerArgs }) {
  const instance = createHash("sha256").update(String(instanceId ?? root)).digest("hex").slice(0, 12);
  const task = createHash("sha256").update(feature).digest("hex").slice(0, 12);
  return [["claude", coderArgs], ["codex", reviewerArgs]].map(([role, childArgs]) => ({
    command: executable,
    role,
    args: [
      "run", "--json", "--bg", "--no-parent", "--keep", "--cwd", projectRoot,
      "--name", `b-${instance}-${task.slice(0, 8)}-${role}`,
      "--label", `herdr.space=bridge-${instance}`, "--label", `herdr.tab=bridge-${instance}-${task}`,
      "--label", `bridge.instance=${instance}`, "--label", `bridge.feature=${task}`, "--label", `bridge.role=${role}`,
      "--", process.execPath, path.join(root, "scripts", "herdr.mjs"), "child",
      Buffer.from(JSON.stringify(childArgs), "utf8").toString("base64")
    ]
  }));
}

export async function launchHerdrPair(options) {
  const warn = options.warn ?? console.warn;
  const fallback = options.platform === "win32" || (!options.platform && process.platform === "win32")
    ? "Windows Terminal (or console fallback)" : "the system terminal";
  const fail = (reason) => { warn(`Warning: Herdr is unavailable: ${reason}. Falling back to ${fallback}. Saved terminal preference is unchanged.`); return false; };
  if (!options.executable) return fail("hc was not found on PATH");
  let live;
  try {
    // Discover before starting either agent, so missing/incompatible hc is safe to fall back from.
    const help = options.run(options.executable, ["run", "--help"]).stdout;
    if (!["--bg", "--no-parent", "--label", "--keep"].every((flag) => help.includes(flag))) return fail("hc lacks required run options");
    live = JSON.parse(options.run(options.executable, ["ls", "--json"]).stdout);
    if (!Array.isArray(live.terminals)) return fail("hc returned an unsupported terminal listing");
  } catch (error) { return fail(error.message); }
  let attempted = false;
  const specs = herdrPairSpecs(options);
  for (const spec of specs) {
    const name = spec.args[spec.args.indexOf("--name") + 1];
    const existing = live.terminals.find((terminal) => terminal.state === "live" && terminal.name === name);
    if (existing) {
      console.log(`Reusing Herdr ${spec.role} terminal ${existing.address}.`);
      continue;
    }
    attempted = true;
    try {
      const started = JSON.parse(options.run(spec.command, spec.args).stdout);
      if (started.error) throw new Error(JSON.stringify(started.error));
      console.log(`Started Herdr ${spec.role} terminal for '${options.feature}'.`);
    } catch (error) {
      // A failed reply can arrive after hc created a terminal. Never launch duplicate agents.
      throw new Error(`Herdr ${spec.role} launch could not be confirmed: ${error.message}. Check 'hc ls --json' and retry the same pair; existing labelled terminals are reused. Automatic fallback was skipped to avoid duplicate sessions.`);
    }
  }
  console.log(`${attempted ? "Opened" : "Reused"} paired Herdr terminals for '${options.feature}'. View them in the Herdr app.`);
  return true;
}

/** Observe actual app-server events, including bridge-injected turns, without parsing screen output. */
export async function statusRelay(upstreamUrl, emit = (state) => reportStatus("codex", state)) {
  const { WebSocket, WebSocketServer } = await import("ws");
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  const sockets = new Set();
  server.on("connection", (downstream) => {
    const upstream = new WebSocket(upstreamUrl);
    sockets.add(downstream); sockets.add(upstream);
    const queue = [];
    const requests = new Set();
    downstream.on("message", (data) => {
      const raw = data.toString();
      try {
        const message = JSON.parse(raw);
        if (requests.delete(message.id) && !requests.size) emit("working");
      } catch { /* Protocol validation belongs to Codex. */ }
      if (upstream.readyState === WebSocket.OPEN) upstream.send(raw);
      else if (upstream.readyState === WebSocket.CONNECTING) queue.push(raw);
    });
    upstream.on("open", () => { for (const raw of queue) upstream.send(raw); queue.length = 0; });
    upstream.on("message", (data) => {
      const raw = data.toString();
      try {
        const message = JSON.parse(raw);
        if (message.method === "turn/started") emit("working");
        if (message.method === "turn/completed") emit(message.params?.turn?.status === "failed" ? "error" : "done");
        if (message.id !== undefined && /(?:requestApproval|requestUserInput)$/.test(message.method ?? "")) {
          requests.add(message.id); emit("blocked");
        }
      } catch { /* Forward unmodified. */ }
      if (downstream.readyState === WebSocket.OPEN) downstream.send(raw);
    });
    for (const [source, target] of [[downstream, upstream], [upstream, downstream]]) {
      source.on("error", () => { emit("error"); target.close(); });
      source.on("close", () => { sockets.delete(source); target.close(); });
    }
  });
  return {
    url: `ws://127.0.0.1:${server.address().port}`,
    close() { for (const socket of sockets) socket.terminate(); server.close(); }
  };
}

export async function runReviewer(invocation, cwd) {
  const encodedArgs = invocation.env.REVIEWER_EXTERNAL_ARGUMENTS;
  const args = encodedArgs ? JSON.parse(encodedArgs) : [...invocation.args];
  const remote = args.indexOf("--remote");
  const relay = remote >= 0 ? await statusRelay(args[remote + 1]) : undefined;
  if (relay) args[remote + 1] = relay.url;
  reportStatus("codex", "blocked");
  try {
    const child = spawn(invocation.command, encodedArgs ? invocation.args : args, {
      cwd, stdio: "inherit", env: encodedArgs ? { ...invocation.env, REVIEWER_EXTERNAL_ARGUMENTS: JSON.stringify(args) } : invocation.env
    });
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code) => resolve(code ?? 1)); });
    if (code !== 0) throw new Error(`codex exited with code ${code}.`);
  } finally { relay?.close(); }
}

// Node resolves the module URL through symlinks, but argv retains the launch path
// (notably macOS /var versus /private/var). Compare the actual files.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(filename) && process.argv[2] === "child") {
  process.env.REVIEW_BRIDGE_TERMINAL = "herdr";
  // Finish evaluating this module before main imports its status helpers again.
  void import("./reviewer.mjs")
    .then(({ main }) => main(JSON.parse(Buffer.from(process.argv[3], "base64").toString("utf8"))))
    .catch((error) => { reportStatus("bridge", "error"); console.error(error.message); process.exitCode = 1; });
}
