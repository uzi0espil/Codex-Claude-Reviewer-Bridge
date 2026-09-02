import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { reviewToolsManifestProposalSchema } from "../review-tools.js";
import {
  readReviewToolsDetection,
  readReviewToolsManifestFile,
  readReviewToolsManifestRevision,
  readReviewToolsReadinessCache,
  preflightReviewToolsManifest,
  refreshReviewToolsDetection,
  writeReviewToolsReadinessCache,
  writeReviewToolsManifest
} from "../review-tools-store.js";

function fixture(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "review-tools-store-"));
}

test("writes only a validated manifest bound to the selected project with optimistic concurrency", () => {
  const root = fixture();
  const other = fixture();
  const manifestPath = path.join(root, "review-tools.local.json");
  const detectionPath = path.join(root, "review-tools.detected.json");
  try {
    const detection = refreshReviewToolsDetection(root, detectionPath);
    const manifest = reviewToolsManifestProposalSchema.parse({
      schemaVersion: 2,
      projectRoot: root,
      detectionSha256: detection.sha256,
      runnerPolicy: { host: "allowed", compose: "allowed", composeExec: "allowed", composeStageExec: "allowed" },
      requirements: [],
      coverage: [],
      tools: [{
        id: "node_version",
        title: "Node version",
        description: "Inspect the Node runtime.",
        runner: { kind: "host", command: process.execPath, args: ["--version"], cwd: "." },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        evidence: ["package.json"]
      }]
    });
    const before = Date.now();
    const created = writeReviewToolsManifest(manifest, null, manifestPath, root, detectionPath);
    assert.equal(created.created, true);
    assert.equal(created.toolCount, 1);
    assert.equal(created.requirementCount, 0);
    assert.equal(created.restartRequired, true);
    assert.equal(Date.parse(created.approvedAt) >= before, true);
    assert.equal(readReviewToolsManifestFile(manifestPath, root)?.sha256, created.sha256);
    assert.throws(() => writeReviewToolsManifest(manifest, null, manifestPath, root, detectionPath), /changed since it was inspected/);
    assert.throws(
      () => writeReviewToolsManifest({ ...manifest, projectRoot: other }, created.sha256, manifestPath, root, detectionPath),
      /must be bound/
    );
    assert.throws(
      () => writeReviewToolsManifest({
        ...manifest,
        tools: [{ ...manifest.tools[0], runner: { ...manifest.tools[0].runner, cwd: "../outside" } }]
      }, created.sha256, manifestPath, root, detectionPath),
      /leaves the bound repository/
    );
    fs.writeFileSync(manifestPath, "{invalid json\n", "utf8");
    const invalidRevision = readReviewToolsManifestRevision(manifestPath);
    assert.equal(typeof invalidRevision?.sha256, "string");
    const repaired = writeReviewToolsManifest(manifest, invalidRevision!.sha256, manifestPath, root, detectionPath);
    assert.equal(readReviewToolsManifestFile(manifestPath, root)?.sha256, repaired.sha256);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(other, { recursive: true, force: true });
  }
});

test("rejects secret-like manifest environment values before writing", () => {
  const root = fixture();
  const manifestPath = path.join(root, "review-tools.local.json");
  const detectionPath = path.join(root, "review-tools.detected.json");
  try {
    const detection = refreshReviewToolsDetection(root, detectionPath);
    assert.throws(() => writeReviewToolsManifest({
      schemaVersion: 2,
      projectRoot: root,
      detectionSha256: detection.sha256,
      runnerPolicy: { host: "allowed", compose: "allowed", composeExec: "allowed", composeStageExec: "allowed" },
      requirements: [],
      coverage: [],
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
    }, null, manifestPath, root, detectionPath), /may contain a secret/);
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

test("caches readiness evidence only for the matching manifest revision", () => {
  const root = fixture();
  const cachePath = path.join(root, "runtime", "readiness.json");
  const manifestSha = "a".repeat(64);
  try {
    const record = {
      success: true,
      probedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      exitCode: 0,
      timedOut: false,
      durationMs: 12
    };
    writeReviewToolsReadinessCache(manifestSha, { backend: record }, cachePath);
    assert.deepEqual(readReviewToolsReadinessCache(manifestSha, cachePath)?.tools.backend, record);
    assert.equal(readReviewToolsReadinessCache("b".repeat(64), cachePath), undefined);
    fs.writeFileSync(cachePath, "{invalid json\n", "utf8");
    assert.equal(readReviewToolsReadinessCache(manifestSha, cachePath), undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("preflight enforces detected CI coverage while allowing one Compose execution route per check", () => {
  const root = fixture();
  const detectionPath = path.join(root, "review-tools.detected.json");
  try {
    fs.mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
    fs.mkdirSync(path.join(root, "backend"));
    fs.mkdirSync(path.join(root, "frontend"));
    fs.writeFileSync(path.join(root, "compose.yml"), [
      "services:",
      "  backend:",
      "    image: fixture-backend",
      "  frontend:",
      "    image: fixture-frontend",
      ""
    ].join("\n"));
    fs.writeFileSync(path.join(root, ".github", "workflows", "ci.yml"), [
      "name: CI",
      "on: [push, pull_request]",
      "jobs:",
      "  backend:",
      "    services:",
      "      postgres:",
      "        image: postgres:16",
      "    steps:",
      "      - name: Install dependencies",
      "        run: uv sync --frozen",
      "      - name: Backend tests",
      "        working-directory: backend",
      "        run: |",
      "          uv run pytest -q",
      "  frontend:",
      "    steps:",
      "      - name: Frontend checks",
      "        working-directory: frontend",
      "        run: npm run test:run",
      ""
    ].join("\n"));
    const detection = refreshReviewToolsDetection(root, detectionPath);
    assert.equal(detection.value.requirements.length, 3);
    assert.equal(detection.value.requirements.find(({ title }) => title.startsWith("Install dependencies"))?.role, "support");
    const backendDetected = detection.value.requirements.find(({ title }) => title.startsWith("Backend tests"))!;
    const frontendDetected = detection.value.requirements.find(({ title }) => title.startsWith("Frontend checks"))!;
    assert.deepEqual(backendDetected.services, ["postgres"]);
    assert.equal(backendDetected.cwd, "backend");
    assert.equal(backendDetected.command, "uv run pytest -q");
    assert.equal(backendDetected.role, "validation");

    const proposal = reviewToolsManifestProposalSchema.parse({
      schemaVersion: 2,
      projectRoot: root,
      detectionSha256: detection.sha256,
      runnerPolicy: { host: "disallowed", compose: "allowed", composeExec: "allowed", composeStageExec: "disallowed" },
      readinessDefaults: { mode: "trusted" },
      requirements: [
        {
          id: "backend_tests",
          title: "Backend tests",
          description: "Run backend tests with their service dependencies.",
          requiredWhen: "Backend CI paths change.",
          procedure: ["Run the CI-equivalent pytest invocation."],
          prerequisites: ["PostgreSQL service"],
          allowedRunners: ["compose_exec"],
          evidence: [backendDetected.source],
          detectedRequirementIds: [backendDetected.id]
        },
        {
          id: "frontend_checks",
          title: "Frontend checks",
          description: "Run frontend checks.",
          requiredWhen: "Frontend CI paths change.",
          procedure: ["Run the non-watch frontend tests."],
          allowedRunners: ["compose_exec"],
          evidence: [frontendDetected.source],
          detectedRequirementIds: [frontendDetected.id]
        }
      ],
      coverage: [
        { requirementId: "backend_tests", disposition: "tool", toolIds: ["backend_tests"] },
        { requirementId: "frontend_checks", disposition: "tool", toolIds: ["frontend_checks"] }
      ],
      tools: [
        {
          id: "backend_tests",
          title: "Backend tests",
          description: "Run backend tests in the existing backend service.",
          runner: { kind: "compose_exec", files: ["compose.yml"], service: "backend", workdir: "/app/backend", command: "uv", args: ["run", "pytest", "-q"], cwd: "." },
          evidence: [backendDetected.source]
        },
        {
          id: "frontend_checks",
          title: "Frontend checks",
          description: "Run frontend checks in the existing frontend service.",
          runner: { kind: "compose_exec", files: ["compose.yml"], service: "frontend", workdir: "/app", command: "npm", args: ["run", "test:run"], cwd: "." },
          evidence: [frontendDetected.source]
        }
      ]
    });
    const result = preflightReviewToolsManifest(proposal, root, detectionPath, () => true);
    assert.equal(result.valid, true);
    assert.equal(result.writable, true);
    assert.deepEqual(result.coverage, {
      requirementCount: 2,
      coveredByTools: 2,
      acceptedGaps: 0,
      pendingGaps: 0,
      detectedRequirementCount: 2
    });
    assert.deepEqual(result.commandPreviews.map(({ runner }) => runner), ["compose_exec", "compose_exec"]);
    assert.equal(result.commandPreviews[0].command.join(" ").includes("exec -T -w /app/backend backend uv run pytest -q"), true);

    const incomplete = preflightReviewToolsManifest({
      ...proposal,
      requirements: proposal.requirements.slice(0, 1),
      coverage: proposal.coverage.slice(0, 1),
      tools: proposal.tools.slice(0, 1)
    }, root, detectionPath, () => true);
    assert.equal(incomplete.valid, false);
    assert.match(incomplete.errors.join("\n"), /absent from the curated inventory/);

    const observational = preflightReviewToolsManifest({
      ...proposal,
      tools: [{
        ...proposal.tools[0],
        runner: { kind: "compose", files: ["compose.yml"], args: ["ps", "--all"], cwd: ".", environment: {} }
      }, proposal.tools[1]]
    }, root, detectionPath, () => true);
    assert.equal(observational.valid, false);
    assert.match(observational.errors.join("\n"), /not an allowed runner for validation requirement 'backend_tests'/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("preflight rejects stale detection, disallowed runners, missing services, and pending gaps", () => {
  const root = fixture();
  const detectionPath = path.join(root, "review-tools.detected.json");
  try {
    fs.writeFileSync(path.join(root, "compose.yml"), "services:\n  backend:\n    image: fixture\n");
    const detection = refreshReviewToolsDetection(root, detectionPath);
    const base = {
      schemaVersion: 2 as const,
      projectRoot: root,
      detectionSha256: detection.sha256,
      runnerPolicy: { host: "allowed" as const, compose: "allowed" as const, composeExec: "disallowed" as const, composeStageExec: "disallowed" as const },
      readinessDefaults: { mode: "trusted" as const },
      requirements: [{
        id: "backend_tests", title: "Backend tests", description: "Run tests.", requiredWhen: "Backend changes.",
        procedure: ["Run pytest."], prerequisites: [], allowedRunners: ["compose_exec" as const], evidence: ["compose.yml"], detectedRequirementIds: []
      }],
      coverage: [{ requirementId: "backend_tests", disposition: "gap" as const, reason: "Not yet runnable.", accepted: false }],
      tools: []
    };
    const pending = preflightReviewToolsManifest(base, root, detectionPath, () => true);
    assert.equal(pending.valid, true);
    assert.equal(pending.writable, false);
    assert.equal(pending.coverage.pendingGaps, 1);
    assert.throws(
      () => writeReviewToolsManifest(base, null, path.join(root, "pending.json"), root, detectionPath),
      /still await explicit approval/
    );
    const accepted = writeReviewToolsManifest({
      ...base,
      coverage: [{ ...base.coverage[0], accepted: true }]
    }, null, path.join(root, "accepted.json"), root, detectionPath);
    assert.equal(accepted.acceptedGapCount, 1);
    assert.equal(accepted.requirementCount, 1);

    const wrongService = preflightReviewToolsManifest({
      ...base,
      coverage: [{ requirementId: "backend_tests", disposition: "tool", toolIds: ["backend_tests"] }],
      tools: [{
        id: "backend_tests", title: "Backend tests", description: "Run tests.",
        runner: { kind: "compose_exec", files: ["compose.yml"], service: "missing", command: "pytest", args: [], cwd: "." },
        inputs: [], timeoutSeconds: 60,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }, evidence: ["compose.yml"]
      }]
    }, root, detectionPath, () => true);
    assert.equal(wrongService.valid, false);
    assert.match(wrongService.errors.join("\n"), /runner policy 'composeExec' is disallowed/);
    assert.match(wrongService.errors.join("\n"), /Compose service is not declared/);

    const stale = preflightReviewToolsManifest({ ...base, detectionSha256: "a".repeat(64) }, root, detectionPath, () => true);
    assert.equal(stale.valid, false);
    assert.match(stale.errors.join("\n"), /Detection changed since the proposal was built/);

    const missingHost = preflightReviewToolsManifest({
      ...base,
      runnerPolicy: { ...base.runnerPolicy, composeExec: "allowed" },
      requirements: [{ ...base.requirements[0], allowedRunners: ["host"] }],
      coverage: [{ requirementId: "backend_tests", disposition: "tool", toolIds: ["backend_tests"] }],
      tools: [{
        id: "backend_tests", title: "Backend tests", description: "Run tests.",
        runner: { kind: "host", command: "definitely-missing", args: ["test"], cwd: "." },
        inputs: [], timeoutSeconds: 60,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }, evidence: ["compose.yml"]
      }]
    }, root, detectionPath, (command) => command !== "definitely-missing");
    assert.equal(missingHost.valid, false);
    assert.match(missingHost.errors.join("\n"), /Executable is unavailable on the host PATH/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
