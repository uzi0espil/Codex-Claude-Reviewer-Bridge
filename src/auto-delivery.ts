export type AutoOutboundDecision = "continue" | "revise";

export interface AutoDeliveryPlan {
  outcome: "continuation-sent" | "continuation-awaiting-user" | "revision-sent" | "revision-queued";
  status: "waiting-user" | "waiting-claude";
  clearPending: boolean;
  queueForNextPrompt: boolean;
}

export function planAutoDelivery(decision: AutoOutboundDecision, stopHookConnected: boolean): AutoDeliveryPlan {
  if (decision === "continue") {
    return stopHookConnected
      ? { outcome: "continuation-sent", status: "waiting-claude", clearPending: true, queueForNextPrompt: false }
      : { outcome: "continuation-awaiting-user", status: "waiting-user", clearPending: false, queueForNextPrompt: false };
  }
  return stopHookConnected
    ? { outcome: "revision-sent", status: "waiting-claude", clearPending: true, queueForNextPrompt: false }
    : { outcome: "revision-queued", status: "waiting-claude", clearPending: true, queueForNextPrompt: true };
}
