import { ClaudeBackgroundTask, FeaturePair } from "./types.js";

const maxBackgroundTasks = 10;
const maxBackgroundTaskFieldLength = 300;

function boundedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text) return undefined;
  return text.length <= maxBackgroundTaskFieldLength
    ? text
    : `${text.slice(0, maxBackgroundTaskFieldLength - 1)}…`;
}

export function normalizeBackgroundTasks(value: unknown): ClaudeBackgroundTask[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, maxBackgroundTasks).flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const task = candidate as Record<string, unknown>;
    const id = boundedString(task.id);
    const type = boundedString(task.type);
    const status = boundedString(task.status);
    if (!id || !type || !status) return [];
    return [{
      id,
      type,
      status,
      description: boundedString(task.description),
      command: boundedString(task.command),
      agentType: boundedString(task.agent_type),
      server: boundedString(task.server),
      tool: boundedString(task.tool),
      name: boundedString(task.name)
    }];
  });
}

export function checkpointDeferralError(pair: FeaturePair, checkpointId: unknown): string | undefined {
  if (pair.mode === "off") return "checkpoint deferral requires bridge mode manual, once, or auto";
  if (pair.status !== "reviewing" || !pair.pending) return "there is no checkpoint review in progress";
  if (!checkpointId || String(checkpointId) !== pair.pending.id) {
    return `checkpoint ${String(checkpointId ?? "")} is not the active checkpoint ${pair.pending.id}`;
  }
  if (!pair.pending.interim || !pair.pending.backgroundTasks?.length) {
    return "only a checkpoint with background work in flight can be deferred";
  }
  if (pair.pending.deferDecision) return "checkpoint deferral is already recorded";
  if (pair.pending.autoDecision) return `automatic decision already recorded as ${pair.pending.autoDecision}`;
  return undefined;
}

export function formatBackgroundTasks(tasks: ClaudeBackgroundTask[]): string {
  return tasks.map((task) => {
    const taskDetail = task.description ?? (task.command ? `command: ${task.command}` : undefined);
    const sourceDetail = task.agentType
      ? `agent: ${task.agentType}`
      : task.server
        ? `server: ${task.server}${task.tool ? `; tool: ${task.tool}` : ""}`
        : task.name ? `workflow: ${task.name}` : undefined;
    const details = [taskDetail, sourceDetail].filter((item): item is string => Boolean(item));
    const suffix = details.length ? ` — ${details.join("; ")}` : "";
    return `- ${task.type} ${task.id} (${task.status})${suffix}`;
  }).join("\n");
}
