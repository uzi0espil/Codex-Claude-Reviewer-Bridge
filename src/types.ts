export type BridgeMode = "off" | "manual" | "once" | "auto";
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
  createdAt: string;
}

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
  mode: BridgeMode;
  status: PairStatus;
  checkpointSequence?: number;
  autoRound: number;
  pmSeeded: boolean;
  initialPrompt?: string;
  pending?: PendingReview;
  queuedClaudeContext?: string;
  questionAdvisoryQueue?: QuestionAdvisory[];
  activeQuestionAdvisory?: QuestionAdvisory;
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
  tool_name?: string;
  tool_input?: {
    questions?: unknown;
    answers?: Record<string, string>;
    [key: string]: unknown;
  };
  tool_use_id?: string;
}

export interface AutoReviewResult {
  decision: "pass" | "revise" | "needs_user";
  feedback: string;
  summary: string;
}
