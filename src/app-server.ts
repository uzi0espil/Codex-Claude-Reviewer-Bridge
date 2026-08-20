import { EventEmitter } from "node:events";

type JsonObject = Record<string, unknown>;

interface PendingRpc {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
}

export interface CompletedTurn {
  threadId: string;
  turnId: string;
  text: string;
  status: string;
  error?: unknown;
}

export class AppServerClient extends EventEmitter {
  private socket?: WebSocket;
  private nextId = 1;
  private pending = new Map<number, PendingRpc>();
  private turnText = new Map<string, string>();

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
    await this.request("initialize", {
      clientInfo: { name: "claude-codex-review-bridge", title: "Claude-Codex Review Bridge", version: "0.2.0" },
      capabilities: { experimentalApi: true, requestAttestation: false }
    });
    this.notify("initialized", {});
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

  async startReview(threadId: string, projectRoot: string, prompt: string, auto: boolean): Promise<string> {
    const outputSchema = auto ? {
      type: "object",
      additionalProperties: false,
      required: ["decision", "feedback", "summary"],
      properties: {
        decision: { type: "string", enum: ["pass", "revise", "needs_user"] },
        feedback: { type: "string" },
        summary: { type: "string" }
      }
    } : undefined;
    const result = await this.request("turn/start", {
      threadId,
      cwd: projectRoot,
      runtimeWorkspaceRoots: [projectRoot],
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly", networkAccess: true },
      input: [{ type: "text", text: prompt, text_elements: [] }],
      outputSchema
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
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      else pending.resolve(message.result);
      return;
    }
    if (message.method === "item/completed") {
      const { item, turnId } = message.params ?? {};
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
}
