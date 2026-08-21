#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-just-"));

function invoke(args) {
  const result = spawnSync("just", ["--justfile", path.join(fixture, "justfile"), ...args], {
    cwd: fixture,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim());
}

try {
  fs.mkdirSync(path.join(fixture, "scripts"));
  fs.copyFileSync(path.join(repositoryRoot, "justfile"), path.join(fixture, "justfile"));
  fs.writeFileSync(
    path.join(fixture, "scripts", "reviewer.mjs"),
    "export async function main(args) { console.log(JSON.stringify(args)); }\n",
    "utf8",
  );

  assert.deepEqual(
    invoke(["pair", "feature name", "--", "--model", "opus 4.1", "--append-system-prompt", "Don't flatten this"]),
    ["start-pair", "--feature", "feature name", "--", "--model", "opus 4.1", "--append-system-prompt", "Don't flatten this"],
  );
  assert.deepEqual(
    invoke(["create", "E:\\dev\\App With Spaces", "--", "--destination", "E:\\dev\\App's Reviewer"]),
    ["create", "--project-root", "E:\\dev\\App With Spaces", "--destination", "E:\\dev\\App's Reviewer"],
  );
  assert.deepEqual(
    invoke(["reviewer", "--", "start-reviewer", "--feature", "raw feature", "--", "--model", "o3"]),
    ["start-reviewer", "--feature", "raw feature", "--", "--model", "o3"],
  );
  console.log("Just recipe argument forwarding passed.");
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}
