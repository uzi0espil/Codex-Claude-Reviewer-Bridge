import { EventEmitter } from "node:events";
import { bridgeVersion } from "./version.js";

type JsonObject = Record<string, unknown>;
type JsonRpcId = string | number;

interface PendingRpc {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
}

interface DownstreamRequest {
  downstreamId: JsonRpcId;
  generation: number;
}

interface DownstreamConnection {
  generation: number;
  send: (raw: string) => void;
}

export interface CompletedTurn {
  threadId: string;
  turnId: string;
  text: string;
  status: string;
  error?: unknown;
}

export interface StartedTurn {
  threadId: string;
  turnId: string;
}

export class AppServerClient extends EventEmitter {
  private socket?: WebSocket;
  private nextId = 1;
  private nextDownstreamGeneration = 1;
  private nextServerRequestId = -1;
  private pending = new Map<number, PendingRpc>();
  private downstreamRequests = new Map<number, DownstreamRequest>();
  private serverRequests = new Map<number, JsonRpcId>();
  private turnText = new Map<string, string>();
  private initializeResult?: unknown;
  private downstream?: DownstreamConnection;

  constructor(readonly url: string) {
    super();
  }

  async connect(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    this.socket = new WebSocket(this.url);
    await new Promise<void>((resolve, reject) => {
      const socket = this.socket!;
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error(`Could not connect to Codex app-server at ${this.url}.`)), { once: true });
    });
    this.socket.addEventListener("message", (event) => this.onMessage(String(event.data)));
    this.socket.addEventListener("close", () => {
      for (const item of this.pending.values()) item.reject(new Error("Codex app-server connection closed."));
      this.pending.clear();
      this.emit("close");
    });
    this.initializeResult = await this.request("initialize", {
      clientInfo: { name: "claude-codex-review-bridge", title: "Claude-Codex Review Bridge", version: bridgeVersion },
      capabilities: { experimentalApi: true, requestAttestation: false }
    });
    this.notify("initialized", {});
  }

  attachDownstream(send: (raw: string) => void): number {
    const generation = this.nextDownstreamGeneration++;
    this.serverRequests.clear();
    this.downstream = { generation, send };
    return generation;
  }

  detachDownstream(generation: number): void {
    if (this.downstream?.generation !== generation) return;
    this.downstream = undefined;
    for (const [id, request] of this.downstreamRequests) {
      if (request.generation === generation) this.downstreamRequests.delete(id);
    }
    this.serverRequests.clear();
  }

  handleDownstreamMessage(raw: string, generation: number): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error("Codex app-server is not connected.");
    if (this.downstream?.generation !== generation) return;

    let message: any;
    try { message = JSON.parse(raw); } catch { return; }

    if (message.method === "initialize" && isJsonRpcId(message.id)) {
      this.sendDownstream({ jsonrpc: "2.0", id: message.id, result: this.initializeResult }, generation);
      return;
    }
    if (message.method === "initialized") return;

    if (!message.method && typeof message.id === "number" && this.serverRequests.has(message.id)) {
      const upstreamId = this.serverRequests.get(message.id)!;
      this.serverRequests.delete(message.id);
      this.socket.send(JSON.stringify({ ...message, id: upstreamId }));
      return;
    }

    if (message.method && isJsonRpcId(message.id)) {
      const upstreamId = this.nextId++;
      this.downstreamRequests.set(upstreamId, { downstreamId: message.id, generation });
      this.socket.send(JSON.stringify({ ...message, id: upstreamId }));
      return;
    }

    this.socket.send(raw);
  }

  close(): void {
    this.socket?.close();
  }

  async createThread(projectRoot: string, name: string): Promise<string> {
    const result = await this.request("thread/start", {
      cwd: projectRoot,
      runtimeWorkspaceRoots: [projectRoot],
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: false
    });
    const threadId = String(result.thread.id);
    await this.request("thread/name/set", { threadId, name });
    return threadId;
  }

  async resumeThread(threadId: string, projectRoot: string): Promise<void> {
    await this.request("thread/resume", {
      threadId,
      cwd: projectRoot,
      runtimeWorkspaceRoots: [projectRoot],
      approvalPolicy: "never",
      sandbox: "read-only",
      excludeTurns: true
    });
  }

  async seedContext(threadId: string, text: string): Promise<void> {
    await this.request("thread/inject_items", {
      threadId,
      items: [{ type: "message", role: "user", content: [{ type: "input_text", text }] }]
    });
  }

  async startReview(threadId: string, projectRoot: string, prompt: string): Promise<string> {
    const result = await this.request("turn/start", {
      threadId,
      cwd: projectRoot,
      runtimeWorkspaceRoots: [projectRoot],
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly", networkAccess: true },
      input: [{ type: "text", text: prompt, text_elements: [] }]
    });
    return String(result.turn.id);
  }

  async startQuestionAdvisory(threadId: string, projectRoot: string, prompt: string): Promise<string> {
    const result = await this.request("turn/start", {
      threadId,
      cwd: projectRoot,
      runtimeWorkspaceRoots: [projectRoot],
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly", networkAccess: true },
      input: [{ type: "text", text: prompt, text_elements: [] }]
    });
    return String(result.turn.id);
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.request("turn/interrupt", { threadId, turnId });
  }

  private request(method: string, params: JsonObject): Promise<any> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error("Codex app-server is not connected.");
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  private notify(method: string, params: JsonObject): void {
    this.socket?.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  private onMessage(raw: string): void {
    let message: any;
    try { message = JSON.parse(raw); } catch { return; }
    if (!message.method && typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (pending) {
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
        else pending.resolve(message.result);
        return;
      }
      const downstream = this.downstreamRequests.get(message.id);
      if (!downstream) return;
      this.downstreamRequests.delete(message.id);
      this.sendDownstream({ ...message, id: downstream.downstreamId }, downstream.generation);
      return;
    }

    if (message.method && isJsonRpcId(message.id)) {
      if (!this.downstream) {
        this.socket?.send(JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32000, message: "Interactive Codex reviewer is not connected." }
        }));
        return;
      }
      const downstreamId = this.nextServerRequestId--;
      this.serverRequests.set(downstreamId, message.id);
      this.sendDownstream({ ...message, id: downstreamId }, this.downstream.generation);
      return;
    }

    this.sendDownstream(message);
    if (message.method === "turn/started") {
      const { threadId, turn } = message.params ?? {};
      this.emit("turnStarted", { threadId: String(threadId ?? ""), turnId: String(turn?.id ?? "") } satisfies StartedTurn);
      return;
    }
    if (message.method === "item/completed") {
      const { item, threadId, turnId } = message.params ?? {};
      if (item?.type === "contextCompaction") this.emit("contextCompacted", String(threadId ?? ""));
      if (item?.type === "agentMessage") this.turnText.set(String(turnId), String(item.text ?? ""));
      return;
    }
    if (message.method === "turn/completed") {
      const { threadId, turn } = message.params ?? {};
      const turnId = String(turn?.id ?? "");
      const completed: CompletedTurn = {
        threadId: String(threadId),
        turnId,
        text: this.turnText.get(turnId) ?? "",
        status: String(turn?.status ?? "unknown"),
        error: turn?.error
      };
      this.turnText.delete(turnId);
      this.emit("turnCompleted", completed);
    }
  }

  private sendDownstream(message: unknown, generation = this.downstream?.generation): void {
    if (generation === undefined || this.downstream?.generation !== generation) return;
    this.downstream.send(JSON.stringify(message));
  }
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === "number" || typeof value === "string";
}
