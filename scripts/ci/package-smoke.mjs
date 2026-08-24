import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { packageRoot, stageNpmPackage } from "./stage-npm-package.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const sourceMetadata = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));
stageNpmPackage();
const metadata = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));

assert.equal(sourceMetadata.private, true, "the reviewer factory must not be published directly");
assert.equal(metadata.private, undefined, "the staged npm package must not be marked private");
assert.equal(metadata.version, sourceMetadata.version, "the staged package version must match the reviewer factory");
assert.equal(metadata.bin?.["claude-codex-review-bridge"], "scripts/npm-bootstrap.mjs");
assert.equal(metadata.publishConfig?.access, "public");
assert.equal(metadata.dependencies, undefined, "the npx bootstrap package must not install runtime dependencies");
assert.equal(metadata.devDependencies, undefined, "the npx bootstrap package must not install development dependencies");
assert.equal(metadata.scripts, undefined, "the npx bootstrap package must not run lifecycle scripts");

const help = spawnSync(process.execPath, [path.join(packageRoot, "scripts", "npm-bootstrap.mjs"), "--help"], {
  cwd: packageRoot,
  encoding: "utf8"
});
assert.equal(help.status, 0, help.stderr || help.stdout);
assert.match(help.stdout, /create --project-root/);

const packed = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
  cwd: packageRoot,
  encoding: "utf8",
  shell: process.platform === "win32"
});
assert.equal(packed.status, 0, packed.stderr || packed.stdout);
const preview = JSON.parse(packed.stdout)[0];
const files = new Set(preview.files.map((entry) => entry.path));
const expectedFiles = [
  "package.json",
  "README.md",
  "LICENSE",
  "scripts/npm-bootstrap.mjs",
  "docs/architecture.md",
  "docs/bootstrap-an-application.md",
  "docs/review-workflows.md",
  ".github/CONTRIBUTING.md",
  ".github/SECURITY.md"
];
assert.deepEqual([...files].sort(), expectedFiles.sort(), "the package must contain only its public bootstrap surface");
assert.ok(preview.unpackedSize < 100_000, `package is unexpectedly large: ${preview.unpackedSize} bytes`);

console.log(`npm package smoke test passed (${files.size} files, ${preview.unpackedSize} unpacked bytes).`);
