import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  isWindowsSubsystemForLinux,
  notificationCommand,
  notificationForAttention,
  sendDesktopNotification
} from "../desktop-notifications.js";

test("attention messages identify the workstream without exposing review content", () => {
  const message = notificationForAttention({
    kind: "question-advice-ready",
    displayName: "  checkout\n retry\u001b  "
  });
  assert.equal(message.title, "Claude needs your answer");
  assert.match(message.body, /^checkout retry:/);
  assert.match(message.body, /answer in Claude/i);
});

test("notification commands preserve payload boundaries on each supported platform", () => {
  const notification = { title: "Review ready", body: "Feature: open Codex." };

  const windows = notificationCommand("win32", notification);
  assert.equal(windows?.command, "powershell.exe");
  assert.deepEqual(windows?.args.slice(0, 4), ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"]);
  const windowsScript = Buffer.from(windows!.args[4], "base64").toString("utf16le");
  assert.match(windowsScript, /ToastNotificationManager/);
  assert.match(windowsScript, new RegExp(Buffer.from(notification.body).toString("base64")));
  assert.equal(windowsScript.includes(notification.body), false);

  const mac = notificationCommand("darwin", notification);
  assert.equal(mac?.command, "osascript");
  assert.deepEqual(mac?.args.slice(-2), [notification.title, notification.body]);

  assert.deepEqual(notificationCommand("linux", notification), {
    command: "notify-send",
    args: ["--app-name", "Claude-Codex Review Bridge", notification.title, notification.body]
  });
  assert.equal(notificationCommand("linux", notification, true)?.command, "powershell.exe");
  assert.equal(notificationCommand("aix", notification), undefined);
});

test("WSL detection uses only Linux interop markers", () => {
  assert.equal(isWindowsSubsystemForLinux({ WSL_DISTRO_NAME: "Ubuntu" }, "linux"), true);
  assert.equal(isWindowsSubsystemForLinux({ WSL_INTEROP: "/run/WSL/1_interop" }, "linux"), true);
  assert.equal(isWindowsSubsystemForLinux({}, "linux"), false);
  assert.equal(isWindowsSubsystemForLinux({ WSL_DISTRO_NAME: "Ubuntu" }, "win32"), false);
});

test("disabled and unsupported notifications never spawn a process", () => {
  let calls = 0;
  const spawn = () => {
    calls += 1;
    return new EventEmitter() as any;
  };
  sendDesktopNotification({ kind: "review-ready-manual", displayName: "Feature" }, {
    enabled: false,
    spawn
  });
  const errors: string[] = [];
  sendDesktopNotification({ kind: "review-ready-manual", displayName: "Feature" }, {
    platform: "aix",
    spawn,
    onError: (message) => errors.push(message)
  });
  assert.equal(calls, 0);
  assert.match(errors[0], /not supported/i);
});

test("notification command failures are reported without throwing", async () => {
  const child = new EventEmitter() as any;
  child.kill = () => true;
  const errors: string[] = [];
  sendDesktopNotification({ kind: "review-failed", displayName: "Feature" }, {
    platform: "linux",
    spawn: () => child,
    timeoutMs: 100,
    onError: (message) => errors.push(message)
  });
  child.emit("error", new Error("missing command"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(errors, ["Could not deliver desktop notification: Error: missing command"]);
});
