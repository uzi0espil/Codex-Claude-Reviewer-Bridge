export type BridgeMode = "off" | "manual" | "once" | "auto";
export type DefaultBridgeMode = Exclude<BridgeMode, "once">;
export type PairStatus =
  | "idle"
  | "reviewing"
  | "waiting-user"
  | "waiting-claude"
  | "passed"
  | "failed";

export interface PendingReview {
  id: string;
  sequence?: number;
  supersedes?: {
    id: string;
    sequence?: number;
  };
  claudeMessage: string;
  codexTurnId?: string;
  codexResponse?: string;
  autoDecision?: AutoReviewDecision;
  autoContinuation?: string;
  interim?: boolean;
  backgroundTasks?: ClaudeBackgroundTask[];
  deferDecision?: boolean;
  deliveryKind?: "feedback" | "continuation";
  source?: "stop" | "pull-queue";
  createdAt: string;
}

export interface ClaudeBackgroundTask {
  id: string;
  type: string;
  status: string;
  description?: string;
  command?: string;
  agentType?: string;
  server?: string;
  tool?: string;
  name?: string;
}

export interface CapturedClaudeMessage {
  id: string;
  claudeSessionId: string;
  message: string;
  capturedAt: string;
  reviewRequestedAt?: string;
  reviewedAt?: string;
  queueRequestedAt?: string;
  queueCheckpointId?: string;
}

export interface PulledReview {
  id: string;
  capturedMessageId: string;
  claudeSessionId: string;
  claudeMessage: string;
  createdAt: string;
  codexTurnId?: string;
}

export type AutoReviewDecision = "pass" | "pass_continue" | "revise" | "needs_user";

export interface ClaudeQuestionOption {
  label: string;
  description?: string;
}

export interface ClaudeQuestion {
  question: string;
  header: string;
  options: ClaudeQuestionOption[];
  multiSelect?: boolean;
}

export interface QuestionAdvisory {
  id: string;
  claudeSessionId: string;
  questions: ClaudeQuestion[];
  createdAt: string;
  codexTurnId?: string;
}

export interface FeaturePair {
  feature: string;
  displayName: string;
  projectRoot: string;
  claudeSessionId?: string;
  claudeSessionStarted?: boolean;
  claudeSessionLifecycleVersion?: number;
  codexThreadId?: string;
  reviewContextSha256?: string;
  reviewContextCompacted?: boolean;
  mode: BridgeMode;
  status: PairStatus;
  checkpointSequence?: number;
  autoRound: number;
  autoRoundLimit: number | null;
  pmSeeded: boolean;
  initialPrompt?: string;
  workstreamContext?: string;
  workstreamContextThreadId?: string;
  pending?: PendingReview;
  queuedClaudeContext?: string;
  questionAdvisoryQueue?: QuestionAdvisory[];
  activeQuestionAdvisory?: QuestionAdvisory;
  pulledReview?: PulledReview;
  capturedClaudeMessage?: CapturedClaudeMessage;
  seenQuestionAdvisoryIds?: string[];
  lastCodexResponse?: string;
  lastForcedPublishAt?: string;
  lastForcedPublishThreadId?: string;
  updatedAt: string;
}

export interface BridgeState {
  version: 1;
  pairs: Record<string, FeaturePair>;
}

export interface EndpointFile {
  url: string;
  token: string;
  appServerUrl: string;
  pid: number;
  startedAt: string;
}

export interface ClaudeHookInput {
  session_id: string;
  transcript_path?: string;
  cwd: string;
  hook_event_name: string;
  prompt?: string;
  last_assistant_message?: string;
  stop_hook_active?: boolean;
  background_tasks?: unknown;
  tool_name?: string;
  tool_input?: {
    questions?: unknown;
    answers?: Record<string, string>;
    [key: string]: unknown;
  };
  tool_use_id?: string;
}
