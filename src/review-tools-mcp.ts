import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { bridgeVersion } from "./version.js";
import {
  executeReviewTool,
  doctorReviewTools,
  loadBoundProjectRoot,
  probeReviewTools,
  recipeInputObjectSchema,
  reviewToolsManifestProposalSchema,
  SingleReviewToolRunner,
  type ReviewToolRecipe,
  type ReviewToolsManifest
} from "./review-tools.js";
import {
  readReviewToolsDetection,
  readReviewToolsManifestFile,
  readReviewToolsManifestRevision,
  readReviewToolsReadinessCache,
  refreshReviewToolsDetection,
  preflightReviewToolsManifest,
  acceptReviewToolsProposalGaps,
  reviewToolsProposalDetails,
  ReviewToolsProposalRegistry,
  summarizeReviewToolsPreflight,
  writeReviewToolsReadinessCache,
  writeReviewToolsManifest,
} from "./review-tools-store.js";

const projectRoot = loadBoundProjectRoot();
const server = new McpServer({ name: "application-review-tools", version: bridgeVersion });
const runner = new SingleReviewToolRunner();
let manifest: ReviewToolsManifest | undefined;
let loadedManifestSha256: string | undefined;
let manifestError: string | undefined;
const proposalRegistry = new ReviewToolsProposalRegistry();
try {
  const loaded = readReviewToolsManifestFile(undefined, projectRoot);
  manifest = loaded?.value;
  loadedManifestSha256 = loaded?.sha256;
} catch (error) {
  manifestError = error instanceof Error ? error.message : String(error);
}

function result(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function failure(error: unknown) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }]
  };
}

server.registerTool("review_tools_status", {
  description: "Show whether generated recommendations and an approved application review-tool manifest exist. This never executes an application command.",
  inputSchema: z.object({}),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
}, async () => {
  let approved: ReturnType<typeof readReviewToolsManifestFile>;
  let currentManifestError: string | undefined;
  try {
    approved = readReviewToolsManifestFile(undefined, projectRoot);
  } catch (error) {
    currentManifestError = error instanceof Error ? error.message : String(error);
  }
  try {
    const detected = readReviewToolsDetection(undefined, projectRoot);
    const revision = readReviewToolsManifestRevision();
    return result({
      projectRoot,
      detection: detected ? {
        sha256: detected.sha256,
        generatedAt: detected.value.generatedAt,
        technologyCount: detected.value.technologies.length,
        validationRequirementCount: detected.value.requirements.filter(({ role }) => role === "validation").length,
        supportStepCount: detected.value.requirements.filter(({ role }) => role === "support").length,
        candidateCount: detected.value.candidates.length
      } : null,
      manifest: approved ? {
        sha256: approved.sha256,
        approvedAt: approved.value.approvedAt,
        toolCount: approved.value.tools.length
      } : revision ? {
        sha256: revision.sha256,
        bytes: revision.bytes,
        invalid: true
      } : null,
      manifestError: currentManifestError ?? manifestError,
      dynamicToolsRequireRestart: (approved?.sha256 ?? undefined) !== loadedManifestSha256
    });
  } catch (error) {
    return failure(error);
  }
});

server.registerTool("review_tools_detected", {
  description: "Read scanner-generated, non-executable tool recommendations and questions for the bound application. Treat candidates as evidence to curate, not as approved commands.",
  inputSchema: z.object({}),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
}, async () => {
  try {
    const detected = readReviewToolsDetection(undefined, projectRoot);
    return result(detected ? { sha256: detected.sha256, ...detected.value } : {
      projectRoot,
      detected: false,
      guidance: "Run review_tools_refresh_detection or the reviewer tools command before proposing a manifest."
    });
  } catch (error) {
    return failure(error);
  }
});

server.registerTool("review_tools_refresh_detection", {
  description: "Rescan the bound repository and replace only the ignored reviewer-local recommendation file. This does not approve or execute any detected command and never writes the application repository.",
  inputSchema: z.object({}),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
}, async () => {
  try {
    const detected = refreshReviewToolsDetection(projectRoot);
    return result({
      projectRoot,
      sha256: detected.sha256,
      generatedAt: detected.value.generatedAt,
      technologies: detected.value.technologies,
      requirements: detected.value.requirements,
      candidateCount: detected.value.candidates.length,
      questions: detected.value.questions
    });
  } catch (error) {
    return failure(error);
  }
});

server.registerTool("review_tools_catalog", {
  description: "List the user-approved, manifest-backed validation capabilities for the bound application. This never executes a command.",
  inputSchema: z.object({}),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
}, async () => result(manifest ? {
  schemaVersion: manifest.schemaVersion,
  projectRoot,
  approvedAt: manifest.approvedAt,
  manifestSha256: loadedManifestSha256,
  readinessDefaults: manifest.readinessDefaults,
  ...(manifest.schemaVersion === 2 ? {
    detectionSha256: manifest.detectionSha256,
    runnerPolicy: manifest.runnerPolicy,
    requirements: manifest.requirements,
    coverage: manifest.coverage
  } : {}),
  tools: manifest.tools
} : {
  projectRoot,
  approved: false,
  error: manifestError,
  guidance: "Use $bridge-init-tools to curate and approve application-specific review tools."
}));

server.registerTool("review_tools_validate_manifest", {
  description: "Validate a complete version-2 manifest proposal without writing it or executing application commands. Returns a concise, hash-bound approval summary instead of echoing the full manifest. The handle can be inspected selectively and later approved.",
  inputSchema: z.object({
    manifest: reviewToolsManifestProposalSchema
  }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
}, async ({ manifest: proposedManifest }) => {
  try {
    const preflight = preflightReviewToolsManifest(proposedManifest, projectRoot);
    if (preflight.manifest) proposalRegistry.add(preflight.manifest);
    return result(summarizeReviewToolsPreflight(preflight));
  } catch (error) {
    return failure(error);
  }
});

server.registerTool("review_tools_proposal_details", {
  description: "Inspect selected requirements or tools from a previously validated proposal handle. Omit both filters only when the user explicitly asks for the entire proposal detail.",
  inputSchema: z.object({
    proposalSha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
    toolIds: z.array(z.string().regex(/^[a-z][a-z0-9_]{1,63}$/)).max(50).optional(),
    requirementIds: z.array(z.string().regex(/^[a-z][a-z0-9_]{1,63}$/)).max(50).optional()
  }).refine(({ toolIds, requirementIds }) => Boolean(toolIds?.length || requirementIds?.length), {
    message: "Select at least one tool or requirement; the concise summary is the default whole-proposal view."
  }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
}, async ({ proposalSha256, toolIds, requirementIds }) => {
  try {
    return result(reviewToolsProposalDetails(proposalRegistry.get(proposalSha256), toolIds, requirementIds));
  } catch (error) {
    return failure(error);
  }
});

server.registerTool("review_tools_doctor", {
  description: "Check approved tool structure and report effective readiness. Static mode never executes commands, trusted mode records the user's approved runtime assumption, and probe mode uses only unexpired results from review_tools_probe.",
  inputSchema: z.object({}),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
}, async () => result(manifest ? doctorReviewTools(
  manifest,
  projectRoot,
  undefined,
  loadedManifestSha256 ? readReviewToolsReadinessCache(loadedManifestSha256)?.tools : undefined
) : {
  projectRoot,
  ready: false,
  allReady: false,
  approved: false,
  error: manifestError,
  guidance: "No approved manifest exists. Complete $bridge-init-tools first."
}));

server.registerTool("review_tools_probe", {
  description: "Run fixed, user-approved readiness probes for selected tools, or every configured probe when no ids are supplied. Probe results are cached by manifest hash for their approved duration. This never substitutes an unapproved shell command.",
  inputSchema: z.object({
    toolIds: z.array(z.string().regex(/^[a-z][a-z0-9_]{1,63}$/)).max(200).optional()
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
}, async ({ toolIds }) => {
  try {
    if (!manifest || !loadedManifestSha256) throw new Error("No approved manifest with readiness probes is loaded.");
    const current = readReviewToolsManifestFile(undefined, projectRoot);
    if (current?.sha256 !== loadedManifestSha256) {
      throw new Error("The approved manifest changed after this MCP server started. Start a fresh Codex session before probing readiness.");
    }
    const probed = await probeReviewTools(runner, manifest, toolIds, projectRoot);
    const cache = writeReviewToolsReadinessCache(loadedManifestSha256, probed.results);
    return result({
      manifestSha256: loadedManifestSha256,
      ...probed,
      readiness: doctorReviewTools(manifest, projectRoot, undefined, cache.tools)
    });
  } catch (error) {
    return failure(error);
  }
});

server.registerTool("review_tools_write_manifest", {
  description: "Write the exact hash-bound proposal that the user approved to the fixed reviewer-local file. Pending gaps are accepted mechanically only when acceptPendingGaps is explicitly true. The caller cannot submit or alter manifest JSON at approval time.",
  inputSchema: z.object({
    proposalSha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
    acceptPendingGaps: z.literal(true),
    expectedSha256: z.string().regex(/^[a-fA-F0-9]{64}$/).nullable()
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
}, async ({ proposalSha256, expectedSha256 }) => {
  try {
    const proposedManifest = proposalRegistry.get(proposalSha256);
    const acceptedManifest = acceptReviewToolsProposalGaps(proposedManifest);
    return result({
      proposalSha256,
      ...writeReviewToolsManifest(acceptedManifest, expectedSha256, undefined, projectRoot)
    });
  } catch (error) {
    return failure(error);
  }
});

for (const recipe of manifest?.tools ?? []) {
  const toolName = `review_${recipe.id}`;
  server.registerTool(toolName, {
    description: `${recipe.description}\nRunner: ${recipe.runner.kind}. Approved evidence: ${recipe.evidence.join(", ") || "user-supplied manifest"}. Commands use argv execution without shell interpolation.`,
    inputSchema: recipeInputObjectSchema(recipe),
    annotations: recipe.annotations
  }, async (input) => {
    try {
      return result(await executeReviewTool(runner, recipe as ReviewToolRecipe, input as Record<string, unknown>, projectRoot));
    } catch (error) {
      return failure(error);
    }
  });
}

await serveStdio(() => server);
