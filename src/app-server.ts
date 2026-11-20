import { EventEmitter } from "node:events";
import { bridgeVersion } from "./version.js";

type JsonObject = Record<string, unknown>;
type JsonRpcId = string | number;

const reviewPermissions = "bridge-review";

interface PendingRpc {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
}

export class AppServerRpcError extends Error {
  constructor(readonly detail: any) {
    super(typeof detail?.message === "string" ? detail.message : "App-server request failed.");
  }
}

interface DownstreamRequest {
  downstreamId: JsonRpcId;
  generation: number;
  resource?: string;
  creatingResource?: boolean;
  releaseResource?: boolean;
}

interface DownstreamConnection {
  generation: number;
  send: (raw: string) => void;
  threadId?: string;
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
  private serverRequests = new Map<number, { upstreamId: JsonRpcId; generation: number }>();
  private serverRequestHistory = new Map<JsonRpcId, { downstreamId: number; generation: number }>();
  private resources = new Map<string, { generation: number; field: string; original: string; cleanup: string }>();
  private downstreamCleanup = new Set<Promise<unknown>>();
  private turnText = new Map<string, string>();
  private initializeResult?: unknown;
  private downstreams = new Map<number, DownstreamConnection>();

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
      this.downstreamRequests.clear();
      this.serverRequests.clear();
      this.serverRequestHistory.clear();
      this.resources.clear();
      this.turnText.clear();
      this.emit("close");
    });
    this.initializeResult = await this.request("initialize", {
      clientInfo: { name: "claude-codex-review-bridge", title: "Claude-Codex Review Bridge", version: bridgeVersion },
      capabilities: { experimentalApi: true, requestAttestation: false }
    });
    this.notify("initialized", {});
  }

  attachDownstream(send: (raw: string) => void, threadId?: string): number {
    const generation = this.nextDownstreamGeneration++;
    this.downstreams.set(generation, { generation, send, threadId });
    return generation;
  }

  detachDownstream(generation: number): void {
    if (!this.downstreams.delete(generation)) return;
    for (const [id, request] of this.downstreamRequests) {
      if (request.generation === generation) this.downstreamRequests.delete(id);
    }
    for (const [id, request] of this.serverRequests) {
      if (request.generation !== generation) continue;
      this.serverRequests.delete(id);
      this.rejectServerRequest(request.upstreamId, "Interactive Codex reviewer disconnected.");
    }
    for (const [id, request] of this.serverRequestHistory) {
      if (request.generation === generation) this.serverRequestHistory.delete(id);
    }
    for (const [id, resource] of this.resources) {
      if (resource.generation !== generation) continue;
      this.resources.delete(id);
      if (this.socket?.readyState === WebSocket.OPEN) {
        const cleanup = this.request(resource.cleanup, { [resource.field]: id }, 1_500).catch(() => undefined);
        this.downstreamCleanup.add(cleanup);
        void cleanup.then(() => this.downstreamCleanup.delete(cleanup));
      }
    }
  }

  async drainDownstreamCleanup(): Promise<void> {
    await Promise.all([...this.downstreamCleanup]);
  }

  handleDownstreamMessage(raw: string, generation: number): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error("Codex app-server is not connected.");
    const connection = this.downstreams.get(generation);
    if (!connection) return;

    let message: any;
    try { message = JSON.parse(raw); } catch { return; }

    if (message.method === "initialize" && isJsonRpcId(message.id)) {
      this.sendDownstream({ jsonrpc: "2.0", id: message.id, result: this.initializeResult }, generation);
      return;
    }
    if (message.method === "initialized") return;

    if (!message.method) {
      const request = this.serverRequests.get(message.id);
      if (!request || request.generation !== generation) return;
      this.serverRequests.delete(message.id);
      this.socket.send(JSON.stringify({ ...message, id: request.upstreamId }));
      return;
    }

    // A paired terminal belongs to one persistent thread. Never allow a TUI
    // request to subscribe to or mutate another pair's thread.
    const requestedThread = messageThreadId(message);
    if (connection.threadId && ((requestedThread && requestedThread !== connection.threadId)
      || ["thread/start", "thread/fork"].includes(message.method))) {
      if (isJsonRpcId(message.id)) this.sendDownstream({ jsonrpc: "2.0", id: message.id,
        error: { code: -32602, message: "This reviewer connection is bound to another thread. Start a new feature pair instead." } }, generation);
      return;
    }

    if (message.method && isJsonRpcId(message.id)) {
      const scope = resourceScope(message.method);
      let resource: string | undefined;
      if (scope && typeof message.params?.[scope.field] === "string") {
        const original = message.params[scope.field];
        resource = `${generation}:${scope.field}:${original}`;
        if (scope.create) {
          if (this.resources.has(resource)) {
            this.sendDownstream({ id: message.id, error: { code: -32602, message: "This connection-scoped resource is already active." } }, generation);
            return;
          }
          this.resources.set(resource, { generation, field: scope.field, original, cleanup: scope.cleanup });
        } else if (!this.resources.has(resource)) {
          this.sendDownstream({ id: message.id, error: { code: -32602, message: "Unknown connection-scoped resource." } }, generation);
          return;
        }
        message.params = { ...message.params, [scope.field]: resource };
      }
      if (message.method === "fuzzyFileSearch" && typeof message.params?.cancellationToken === "string") {
        message.params.cancellationToken = `${generation}:${message.params.cancellationToken}`;
      }
      const upstreamId = this.nextId++;
      this.downstreamRequests.set(upstreamId, { downstreamId: message.id, generation, resource,
        creatingResource: scope?.create, releaseResource: scope?.stop || message.method === "command/exec" });
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
      permissions: reviewPermissions,
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
      permissions: reviewPermissions,
      excludeTurns: true
    });
  }

  async seedContext(threadId: string, text: string): Promise<void> {
    await this.request("thread/inject_items", {
      threadId,
      items: [{ type: "message", role: "user", content: [{ type: "input_text", text }] }]
    });
  }

  async readRateLimits(): Promise<unknown> {
    return await this.request("account/rateLimits/read", {});
  }

  async startReview(threadId: string, projectRoot: string, prompt: string): Promise<string> {
    return await this.startReadOnlyTurn(threadId, projectRoot, prompt);
  }

  async startQuestionAdvisory(threadId: string, projectRoot: string, prompt: string): Promise<string> {
    return await this.startReadOnlyTurn(threadId, projectRoot, prompt);
  }

  private async startReadOnlyTurn(threadId: string, projectRoot: string, prompt: string): Promise<string> {
    const result = await this.request("turn/start", {
      threadId,
      cwd: projectRoot,
      runtimeWorkspaceRoots: [projectRoot],
      approvalPolicy: "never",
      permissions: reviewPermissions,
      input: [{ type: "text", text: prompt, text_elements: [] }]
    });
    return String(result.turn.id);
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.request("turn/interrupt", { threadId, turnId });
  }

  private request(method: string, params: JsonObject, timeoutMs = 0): Promise<any> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error("Codex app-server is not connected.");
    const id = this.nextId++;
    const response = new Promise((resolve, reject) => {
      const timer = timeoutMs ? setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`App-server ${method} timed out.`));
      }, timeoutMs) : undefined;
      timer?.unref();
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); }
      });
    });
    this.socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return response;
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
        if (message.error) pending.reject(new AppServerRpcError(message.error));
        else pending.resolve(message.result);
        return;
      }
      const downstream = this.downstreamRequests.get(message.id);
      if (!downstream) return;
      this.downstreamRequests.delete(message.id);
      if (downstream.resource && ((!message.error && downstream.releaseResource) || (message.error && downstream.creatingResource))) this.resources.delete(downstream.resource);
      this.sendDownstream({ ...message, id: downstream.downstreamId }, downstream.generation);
      return;
    }

    if (message.method && isJsonRpcId(message.id)) {
      const recipients = this.recipients(message, false);
      if (recipients.length !== 1) {
        this.rejectServerRequest(message.id, "No unique interactive Codex reviewer is connected for this request.");
        return;
      }
      const downstreamId = this.nextServerRequestId--;
      const generation = recipients[0].generation;
      this.serverRequests.set(downstreamId, { upstreamId: message.id, generation });
      this.serverRequestHistory.set(message.id, { downstreamId, generation });
      // Keep a bounded translation history for serverRequest/resolved after a
      // terminal has already answered. Older servers may omit that event.
      if (this.serverRequestHistory.size > 1_024) this.serverRequestHistory.delete(this.serverRequestHistory.keys().next().value!);
      this.sendDownstream({ ...message, id: downstreamId }, generation);
      return;
    }

    if (message.method === "serverRequest/resolved") {
      const request = this.serverRequestHistory.get(message.params?.requestId);
      if (request) {
        this.serverRequestHistory.delete(message.params.requestId);
        this.serverRequests.delete(request.downstreamId);
        this.sendDownstream({ ...message, params: { ...message.params, requestId: request.downstreamId } }, request.generation);
      }
      return;
    }
    const resourceField = notificationResourceField(message.method);
    if (resourceField) {
      const id = message.params?.[resourceField];
      const resource = this.resources.get(id);
      if (resource) {
        this.sendDownstream({ ...message, params: { ...message.params, [resourceField]: resource.original } }, resource.generation);
        if (message.method === "process/exited") this.resources.delete(id);
      }
      return;
    }
    for (const recipient of this.recipients(message, true)) this.sendDownstream(message, recipient.generation);
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

  private recipients(message: any, notification: boolean): DownstreamConnection[] {
    const threadId = messageThreadId(message);
    return [...this.downstreams.values()].filter((connection) => {
      if (!connection.threadId) return true; // Compatibility with an older, unbound launcher.
      if (threadId) return connection.threadId === threadId;
      // Account state is shared. Unscoped interactive requests are never guessed
      // or broadcast, and unknown notifications cannot leak another thread.
      return notification && (/^(?:account\/|model\/|server\/)/.test(message.method ?? "")
        || ["skills/changed", "project/changed", "app/list/updated", "remoteControl/status/changed",
          "deprecationNotice", "configWarning", "windows/worldWritableWarning", "windowsSandbox/setupCompleted"].includes(message.method));
    });
  }

  private rejectServerRequest(id: JsonRpcId, message: string): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } }));
  }

  private sendDownstream(message: unknown, generation: number): void {
    this.downstreams.get(generation)?.send(JSON.stringify(message));
  }
}

function messageThreadId(message: any): string | undefined {
  const params = message.params;
  const value = params?.threadId ?? params?.thread_id ?? params?.thread?.id ?? params?.conversationId;
  return typeof value === "string" ? value : undefined;
}

function resourceScope(method: string): { field: string; cleanup: string; create: boolean; stop: boolean } | undefined {
  if (method === "command/exec" || method.startsWith("command/exec/")) return {
    field: "processId", cleanup: "command/exec/terminate", create: method === "command/exec", stop: false
  };
  if (method.startsWith("process/")) return {
    field: "processHandle", cleanup: "process/kill", create: method === "process/spawn", stop: false
  };
  if (["fs/watch", "fs/unwatch"].includes(method)) return {
    field: "watchId", cleanup: "fs/unwatch", create: method === "fs/watch", stop: method === "fs/unwatch"
  };
  if (method.startsWith("fuzzyFileSearch/session")) return {
    field: "sessionId", cleanup: "fuzzyFileSearch/sessionStop", create: method === "fuzzyFileSearch/sessionStart", stop: method === "fuzzyFileSearch/sessionStop"
  };
  if (method.startsWith("mcpServer/event/stream/")) return {
    field: "subscriptionId", cleanup: "mcpServer/event/stream/stop", create: method === "mcpServer/event/stream/start", stop: method === "mcpServer/event/stream/stop"
  };
  return undefined;
}

function notificationResourceField(method: string): string | undefined {
  if (method === "command/exec/outputDelta") return "processId";
  if (["process/outputDelta", "process/exited"].includes(method)) return "processHandle";
  if (method === "fs/changed") return "watchId";
  if (method.startsWith("fuzzyFileSearch/session")) return "sessionId";
  if (method === "mcpServer/event/stream/notification") return "subscriptionId";
  return undefined;
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === "number" || typeof value === "string";
}
