import { WebSocket, WebSocketServer } from "ws";
import { randomUUID } from "node:crypto";
import { AppServerClient } from "./app-server.js";

/**
 * Gives each interactive Codex TUI a logical connection while preserving one
 * physical app-server connection. This relies on Codex's experimental remote
 * protocol and deliberately keeps the compatibility surface in one class.
 */
export class AppServerProxy {
  private readonly server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  private readonly routes = new Map<string, { feature: string; threadId: string }>();
  private readonly connections = new Map<string, { socket: WebSocket; generation: number; alive: boolean }>();
  private heartbeat?: ReturnType<typeof setInterval>;
  private closed = false;

  private constructor(private readonly app: AppServerClient) {}

  static async start(app: AppServerClient, heartbeatIntervalMs = 30_000): Promise<AppServerProxy> {
    const proxy = new AppServerProxy(app);
    await new Promise<void>((resolve, reject) => {
      proxy.server.once("listening", resolve);
      proxy.server.once("error", reject);
    });
    proxy.server.on("connection", (socket, request) => proxy.onConnection(socket, request.url ?? "/"));
    app.on("close", proxy.onUpstreamClose);
    proxy.heartbeat = setInterval(() => proxy.checkConnections(), heartbeatIntervalMs);
    proxy.heartbeat.unref();
    return proxy;
  }

  get url(): string {
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Could not determine Codex app-server proxy port.");
    return `ws://127.0.0.1:${address.port}`;
  }

  urlFor(feature: string, threadId: string): string {
    if (this.closed) throw new Error("The reviewer proxy is closed.");
    for (const [route, binding] of this.routes) {
      if (binding.feature !== feature) continue;
      if (binding.threadId === threadId) return this.url + route;
      this.drop(feature, 1012, "The pair's Codex thread was replaced.");
      this.routes.delete(route);
    }
    // Retire the old unbound endpoint once pair-aware launchers are in use.
    this.drop("", 1012, "Reconnect using the feature pair launcher.");
    const route = `/pair/${randomUUID()}`;
    this.routes.set(route, { feature, threadId });
    return this.url + route;
  }

  connected(feature: string): boolean {
    return this.connections.has(feature);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    this.app.off("close", this.onUpstreamClose);
    for (const feature of [...this.connections.keys()]) this.drop(feature, 1001, "Review bridge is shutting down.");
    this.routes.clear();
    this.server.close();
  }

  private readonly onUpstreamClose = (): void => { this.close(); };

  private drop(feature: string, code: number, reason: string): void {
    const connection = this.connections.get(feature);
    if (!connection) return;
    this.connections.delete(feature);
    this.app.detachDownstream(connection.generation);
    this.closeSocket(connection.socket, code, reason);
  }

  private closeSocket(socket: WebSocket, code: number, reason: string): void {
    socket.close(code, reason);
    // A peer that never completes the close handshake must not retain a handle.
    const timer = setTimeout(() => socket.terminate(), 1_000);
    timer.unref();
    socket.once("close", () => clearTimeout(timer));
  }

  private checkConnections(): void {
    for (const [feature, connection] of this.connections) {
      if (!connection.alive) {
        this.drop(feature, 1001, "Reviewer heartbeat timed out.");
        connection.socket.terminate();
      } else {
        connection.alive = false;
        connection.socket.ping();
      }
    }
  }

  private onConnection(socket: WebSocket, route: string): void {
    socket.on("error", () => socket.terminate());
    const binding = this.routes.get(route);
    if (this.closed || (!binding && (route !== "/" || this.routes.size > 0))) {
      this.closeSocket(socket, 1008, "Unknown reviewer connection. Relaunch the feature pair.");
      return;
    }
    const feature = binding?.feature ?? "";
    this.drop(feature, 1012, "A newer connection for this feature replaced this one.");
    const generation = this.app.attachDownstream((raw) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(raw);
    }, binding?.threadId);
    const connection = { socket, generation, alive: true };
    this.connections.set(feature, connection);
    socket.on("pong", () => { connection.alive = true; });

    socket.on("message", (data) => {
      try {
        this.app.handleDownstreamMessage(data.toString(), generation);
      } catch {
        if (socket.readyState === WebSocket.OPEN && this.connections.get(feature) === connection) {
          this.drop(feature, 1011, "App-server proxy error.");
        }
      }
    });
    socket.once("close", () => {
      this.app.detachDownstream(generation);
      if (this.connections.get(feature) === connection) this.connections.delete(feature);
    });
  }
}
