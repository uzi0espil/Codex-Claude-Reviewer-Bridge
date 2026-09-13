import { ChildProcess, SpawnOptions, spawn as nodeSpawn } from "node:child_process";

const applicationName = "Claude-Codex Review Bridge";
const notificationTimeoutMs = 5_000;

export type AttentionEventKind =
  | "review-ready-manual"
  | "review-ready-once"
  | "auto-needs-user"
  | "auto-round-limit"
  | "auto-control-error"
  | "auto-continuation-awaiting-user"
  | "auto-revision-queued"
  | "question-advice-ready"
  | "question-advice-unavailable"
  | "pull-review-ready"
  | "pull-review-failed"
  | "review-failed";

export interface AttentionEvent {
  kind: AttentionEventKind;
  displayName: string;
}

export interface DesktopNotification {
  title: string;
  body: string;
}

export interface NotificationCommand {
  command: string;
  args: string[];
}

type SpawnNotification = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export interface DesktopNotificationOptions {
  enabled?: boolean;
  platform?: NodeJS.Platform;
  isWsl?: boolean;
  spawn?: SpawnNotification;
  timeoutMs?: number;
  onError?: (message: string) => void;
}

function workstreamLabel(value: string): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().replace(/\s+/g, " ");
  return (normalized || "Paired workstream").slice(0, 120);
}

export function notificationForAttention(event: AttentionEvent): DesktopNotification {
  const workstream = workstreamLabel(event.displayName);
  const messages: Record<AttentionEventKind, DesktopNotification> = {
    "review-ready-manual": {
      title: "Review ready",
      body: `${workstream}: open Codex to publish or cancel the review.`
    },
    "review-ready-once": {
      title: "One-time review ready",
      body: `${workstream}: open Codex to publish or cancel the review.`
    },
    "auto-needs-user": {
      title: "Automatic review needs you",
      body: `${workstream}: open Codex to inspect the decision and publish or cancel.`
    },
    "auto-round-limit": {
      title: "Automatic review paused",
      body: `${workstream}: the unattended round limit was reached. Open Codex to decide.`
    },
    "auto-control-error": {
      title: "Automatic review paused",
      body: `${workstream}: Codex could not complete the automatic decision. Open Codex to decide.`
    },
    "auto-continuation-awaiting-user": {
      title: "Continuation needs delivery",
      body: `${workstream}: the Claude Stop hook disconnected. Open Codex to publish or cancel.`
    },
    "auto-revision-queued": {
      title: "Review feedback queued",
      body: `${workstream}: send Claude another prompt to deliver the queued feedback.`
    },
    "question-advice-ready": {
      title: "Claude needs your answer",
      body: `${workstream}: Codex advice is ready. Review it, then answer in Claude.`
    },
    "question-advice-unavailable": {
      title: "Claude still needs your answer",
      body: `${workstream}: Codex advice was unavailable. Answer Claude directly.`
    },
    "pull-review-ready": {
      title: "Pulled review ready",
      body: `${workstream}: open Codex to inspect the review.`
    },
    "pull-review-failed": {
      title: "Pulled review failed",
      body: `${workstream}: open Codex or the bridge log for details.`
    },
    "review-failed": {
      title: "Review bridge needs attention",
      body: `${workstream}: the review failed open and interception was switched off.`
    }
  };
  return messages[event.kind];
}

const windowsToastScript = `
$ErrorActionPreference = 'Stop'
$title = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__TITLE__'))
$body = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__BODY__'))
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$nodes = $xml.GetElementsByTagName('text')
$nodes.Item(0).AppendChild($xml.CreateTextNode($title)) > $null
$nodes.Item(1).AppendChild($xml.CreateTextNode($body)) > $null
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${applicationName}').Show($toast)
`.trim();

function powershellCommand(notification: DesktopNotification, command = "powershell.exe"): NotificationCommand {
  const title = Buffer.from(notification.title, "utf8").toString("base64");
  const body = Buffer.from(notification.body, "utf8").toString("base64");
  const script = windowsToastScript.replace("__TITLE__", title).replace("__BODY__", body);
  return {
    command,
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")]
  };
}

export function notificationCommand(
  platform: NodeJS.Platform,
  notification: DesktopNotification,
  isWsl = false
): NotificationCommand | undefined {
  if (platform === "win32") return powershellCommand(notification);
  if (platform === "darwin") {
    return {
      command: "osascript",
      args: [
        "-e", "on run argv",
        "-e", "display notification (item 2 of argv) with title (item 1 of argv)",
        "-e", "end run",
        notification.title,
        notification.body
      ]
    };
  }
  if (platform === "linux" && isWsl) return powershellCommand(notification, "powershell.exe");
  if (platform === "linux") {
    return {
      command: "notify-send",
      args: ["--app-name", applicationName, notification.title, notification.body]
    };
  }
  return undefined;
}

export function isWindowsSubsystemForLinux(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): boolean {
  return platform === "linux" && Boolean(environment.WSL_DISTRO_NAME || environment.WSL_INTEROP);
}

export function sendDesktopNotification(event: AttentionEvent, options: DesktopNotificationOptions = {}): void {
  if (options.enabled === false) return;
  const reportError = (message: string): void => {
    try { options.onError?.(message); } catch { /* Notification diagnostics must not affect the bridge. */ }
  };
  const platform = options.platform ?? process.platform;
  const command = notificationCommand(
    platform,
    notificationForAttention(event),
    options.isWsl ?? isWindowsSubsystemForLinux(process.env, platform)
  );
  if (!command) {
    reportError(`Desktop notifications are not supported on platform '${platform}'.`);
    return;
  }

  const spawnNotification = options.spawn ?? nodeSpawn;
  let child: ChildProcess;
  try {
    child = spawnNotification(command.command, command.args, {
      stdio: "ignore",
      windowsHide: true
    });
  } catch (error) {
    reportError(`Could not start desktop notification: ${String(error)}`);
    return;
  }

  let settled = false;
  let timer: NodeJS.Timeout | undefined;
  const finish = (message?: string): void => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    if (message) reportError(message);
  };
  child.once("error", (error) => finish(`Could not deliver desktop notification: ${String(error)}`));
  child.once("exit", (code, signal) => {
    if (code === 0) finish();
    else finish(`Desktop notification command exited with ${signal ? `signal ${signal}` : `code ${String(code)}`}.`);
  });
  timer = setTimeout(() => {
    try { child.kill(); } catch { /* The process may already have exited. */ }
    finish(`Desktop notification command timed out after ${options.timeoutMs ?? notificationTimeoutMs}ms.`);
  }, options.timeoutMs ?? notificationTimeoutMs);
  timer.unref();
}
