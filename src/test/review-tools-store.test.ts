import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { reviewToolsManifestSchema } from "../review-tools.js";
import {
  readReviewToolsDetection,
  readReviewToolsManifestFile,
  readReviewToolsManifestRevision,
  refreshReviewToolsDetection,
  writeReviewToolsManifest
} from "../review-tools-store.js";

function fixture(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "review-tools-store-"));
}

test("writes only a validated manifest bound to the selected project with optimistic concurrency", () => {
  const root = fixture();
  const other = fixture();
  const manifestPath = path.join(root, "review-tools.local.json");
  try {
    const manifest = reviewToolsManifestSchema.parse({
      schemaVersion: 1,
      projectRoot: root,
      approvedAt: new Date().toISOString(),
      tools: [{
        id: "node_version",
        title: "Node version",
        description: "Inspect the Node runtime.",
        runner: { kind: "host", command: process.execPath, args: ["--version"], cwd: "." },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        evidence: ["package.json"]
      }]
    });
    const created = writeReviewToolsManifest(manifest, null, manifestPath, root);
    assert.equal(created.created, true);
    assert.equal(created.toolCount, 1);
    assert.equal(created.restartRequired, true);
    assert.equal(readReviewToolsManifestFile(manifestPath, root)?.sha256, created.sha256);
    assert.throws(() => writeReviewToolsManifest(manifest, null, manifestPath, root), /changed since it was inspected/);
    assert.throws(
      () => writeReviewToolsManifest({ ...manifest, projectRoot: other }, created.sha256, manifestPath, root),
      /must be bound/
    );
    assert.throws(
      () => writeReviewToolsManifest({
        ...manifest,
        tools: [{ ...manifest.tools[0], runner: { ...manifest.tools[0].runner, cwd: "../outside" } }]
      }, created.sha256, manifestPath, root),
      /leaves the bound repository/
    );
    fs.writeFileSync(manifestPath, "{invalid json\n", "utf8");
    const invalidRevision = readReviewToolsManifestRevision(manifestPath);
    assert.equal(typeof invalidRevision?.sha256, "string");
    const repaired = writeReviewToolsManifest(manifest, invalidRevision!.sha256, manifestPath, root);
    assert.equal(readReviewToolsManifestFile(manifestPath, root)?.sha256, repaired.sha256);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(other, { recursive: true, force: true });
  }
});

test("rejects secret-like manifest environment values before writing", () => {
  const root = fixture();
  const manifestPath = path.join(root, "review-tools.local.json");
  try {
    assert.throws(() => writeReviewToolsManifest({
      schemaVersion: 1,
      projectRoot: root,
      approvedAt: new Date().toISOString(),
      tools: [{
        id: "unsafe_tool",
        title: "Unsafe",
        description: "Must not be stored.",
        runner: {
          kind: "host",
          command: process.execPath,
          args: [],
          cwd: ".",
          environment: { API_TOKEN: "not-a-real-secret" }
        },
        evidence: ["fixture"]
      }]
    }, null, manifestPath, root), /may contain a secret/);
    assert.equal(fs.existsSync(manifestPath), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("refreshes reviewer-local detection without approving candidates", () => {
  const root = fixture();
  const detectionPath = path.join(root, "review-tools.detected.json");
  try {
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
      scripts: { test: "node --test", start: "node server.js" }
    }));
    const detected = refreshReviewToolsDetection(root, detectionPath);
    assert.equal(detected.value.candidates.some(({ recipe }) => recipe.id === "x_root_test"), true);
    const loaded = readReviewToolsDetection(detectionPath, root);
    assert.equal(loaded?.sha256, detected.sha256);
    assert.equal(fs.existsSync(path.join(root, "review-tools.local.json")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
