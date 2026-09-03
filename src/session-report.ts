import { AutoReviewDecision, BridgeMode, FeaturePair, PendingReview } from "./types.js";

export type CheckpointReportStatus =
  | "reviewing"
  | "waiting-user"
  | "passed"
  | "continuation-sent"
  | "continuation-awaiting-user"
  | "revision-sent"
  | "revision-queued"
  | "published"
  | "cancelled"
  | "superseded"
  | "released-mode-off"
  | "failed";

export interface SessionCheckpointReport {
  checkpointId: string;
  checkpointSequence?: number;
  mode: BridgeMode;
  source: NonNullable<PendingReview["source"]>;
  status: CheckpointReportStatus;
  claudeMessage: string;
  codexTurnId?: string;
  codexResponse?: string;
  decision?: AutoReviewDecision;
  autoRound?: number;
  delivery?: "stop-hook" | "next-prompt";
  createdAt: string;
  completedAt?: string;
  resolvedAt?: string;
  durationMs?: number;
  supersededBy?: {
    id: string;
    sequence?: number;
  };
  note?: string;
}

export type SessionCheckpointUpdate = Partial<Omit<SessionCheckpointReport,
  "checkpointId" | "checkpointSequence" | "mode" | "source" | "claudeMessage" | "createdAt"
>>;

function elapsedMs(startedAt: string, completedAt: string): number {
  const elapsed = Date.parse(completedAt) - Date.parse(startedAt);
  return Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0;
}

function checkpointLabel(entry: SessionCheckpointReport): string {
  return entry.checkpointSequence ? `#${entry.checkpointSequence}` : entry.checkpointId;
}

function workstreamSubject(workstreamContext?: string): string {
  const firstLine = workstreamContext?.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  if (!firstLine) return "Not captured yet";
  const plain = firstLine
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[-*+>]\s+/, "")
    .replace(/\s+/g, " ");
  return plain.length <= 160 ? plain : `${plain.slice(0, 157).trimEnd()}...`;
}

function formatEntry(entry: SessionCheckpointReport, full: boolean): string[] {
  const lines = [
    `## Checkpoint ${checkpointLabel(entry)} - ${entry.status}`,
    "",
    `- ID: ${entry.checkpointId}`,
    `- Mode: ${entry.mode}`,
    `- Source: ${entry.source}`,
    entry.codexTurnId ? `- Codex turn: ${entry.codexTurnId}` : undefined,
    entry.decision ? `- Decision: ${entry.decision}` : undefined,
    entry.autoRound ? `- Unattended round: ${entry.autoRound}` : undefined,
    entry.delivery ? `- Delivery: ${entry.delivery}` : undefined,
    `- Created: ${entry.createdAt}`,
    entry.completedAt ? `- Review completed: ${entry.completedAt}` : undefined,
    entry.resolvedAt ? `- Resolved: ${entry.resolvedAt}` : undefined,
    entry.durationMs !== undefined ? `- Review duration: ${(entry.durationMs / 1000).toFixed(1)} seconds` : undefined,
    entry.supersededBy
      ? `- Superseded by: ${entry.supersededBy.sequence ? `#${entry.supersededBy.sequence} ` : ""}(${entry.supersededBy.id})`
      : undefined,
    entry.note ? `- Note: ${entry.note}` : undefined,
    "",
    "### Claude handoff",
    "",
    full ? entry.claudeMessage.trim() : "_Hidden. Re-run the report with `--full` to include it._",
    "",
    "### Codex report",
    "",
    entry.codexResponse?.trim() || "_Review has not completed._",
    ""
  ];
  return lines.filter((line) => line !== undefined);
}

export class SessionReportLedger {
  private readonly checkpoints = new Map<string, SessionCheckpointReport[]>();

  constructor(readonly startedAt = new Date().toISOString()) {}

  start(pair: FeaturePair, checkpoint: PendingReview): SessionCheckpointReport {
    const entries = this.checkpoints.get(pair.feature) ?? [];
    const existing = entries.find((entry) => entry.checkpointId === checkpoint.id);
    if (existing) return existing;
    const entry: SessionCheckpointReport = {
      checkpointId: checkpoint.id,
      checkpointSequence: checkpoint.sequence,
      mode: pair.mode,
      source: checkpoint.source ?? "stop",
      status: "reviewing",
      claudeMessage: checkpoint.claudeMessage,
      autoRound: pair.mode === "auto" ? pair.autoRound + 1 : undefined,
      createdAt: checkpoint.createdAt
    };
    entries.push(entry);
    this.checkpoints.set(pair.feature, entries);
    return entry;
  }

  update(feature: string, checkpointId: string, update: SessionCheckpointUpdate): SessionCheckpointReport | undefined {
    const entry = this.checkpoints.get(feature)?.find((candidate) => candidate.checkpointId === checkpointId);
    if (!entry) return undefined;
    Object.assign(entry, update);
    return entry;
  }

  complete(
    feature: string,
    checkpointId: string,
    response: string | undefined,
    update: SessionCheckpointUpdate,
    completedAt = new Date().toISOString()
  ): SessionCheckpointReport | undefined {
    const entry = this.update(feature, checkpointId, {
      ...update,
      codexResponse: response?.trim() || undefined,
      completedAt
    });
    if (entry) entry.durationMs = elapsedMs(entry.createdAt, completedAt);
    return entry;
  }

  render(feature: string, displayName: string, full = false, workstreamContext?: string): string {
    const entries = this.checkpoints.get(feature) ?? [];
    const last = entries.at(-1);
    const totalDuration = entries.reduce((total, entry) => total + (entry.durationMs ?? 0), 0);
    const sections = entries.flatMap((entry) => formatEntry(entry, full));
    const initialRequest = full
      ? [
          "## Initial request",
          "",
          workstreamContext?.trim() || "_Not captured yet._",
          ""
        ]
      : [];
    return [
      `# Review session report - ${displayName}`,
      "",
      `- Subject: ${workstreamSubject(workstreamContext)}`,
      `- Checkpoints: ${entries.length}`,
      `- Server started: ${this.startedAt}`,
      last ? `- Latest checkpoint: ${checkpointLabel(last)}` : undefined,
      last ? `- Latest status: ${last.status}` : undefined,
      `- Total review time: ${(totalDuration / 1000).toFixed(1)} seconds`,
      "",
      ...initialRequest,
      ...(entries.length ? sections : ["_No checkpoints have been created during this server session._", ""])
    ].filter((line) => line !== undefined).join("\n");
  }
}
