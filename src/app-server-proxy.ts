import { WebSocket, WebSocketServer } from "ws";
import { AppServerClient } from "./app-server.js";

/**
 * Gives the interactive Codex TUI a logical connection while preserving one
 * physical app-server connection. This relies on Codex's experimental remote
 * protocol and deliberately keeps the compatibility surface in one class.
 */
export class AppServerProxy {
  private readonly server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  private activeSocket?: WebSocket;

  private constructor(private readonly app: AppServerClient) {}

  static async start(app: AppServerClient): Promise<AppServerProxy> {
    const proxy = new AppServerProxy(app);
    await new Promise<void>((resolve, reject) => {
      proxy.server.once("listening", resolve);
      proxy.server.once("error", reject);
    });
    proxy.server.on("connection", (socket) => proxy.onConnection(socket));
    return proxy;
  }

  get url(): string {
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Could not determine Codex app-server proxy port.");
    return `ws://127.0.0.1:${address.port}`;
  }

  close(): void {
    this.activeSocket?.close(1001, "Review bridge is shutting down.");
    this.server.close();
  }

  private onConnection(socket: WebSocket): void {
    this.activeSocket?.close(1012, "A newer Codex reviewer connection replaced this one.");
    this.activeSocket = socket;
    const generation = this.app.attachDownstream((raw) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(raw);
    });

    socket.on("message", (data) => {
      try {
        this.app.handleDownstreamMessage(data.toString(), generation);
      } catch (error) {
        if (socket.readyState === WebSocket.OPEN) {
          socket.close(1011, error instanceof Error ? error.message.slice(0, 123) : "App-server proxy error.");
        }
      }
    });
    socket.once("close", () => {
      this.app.detachDownstream(generation);
      if (this.activeSocket === socket) this.activeSocket = undefined;
    });
  }
}
