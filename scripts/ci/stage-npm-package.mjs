import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const packageRoot = path.join(repositoryRoot, ".npm-package");

const copiedPaths = [
  "README.md",
  "LICENSE",
  "docs",
  path.join(".github", "CONTRIBUTING.md"),
  path.join(".github", "SECURITY.md"),
  path.join("scripts", "npm-bootstrap.mjs")
];

export function stageNpmPackage() {
  if (path.dirname(packageRoot) !== repositoryRoot || path.basename(packageRoot) !== ".npm-package") {
    throw new Error(`Refusing to replace unexpected package staging path: ${packageRoot}`);
  }

  const source = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));
  const metadata = Object.fromEntries([
    "name",
    "version",
    "description",
    "license",
    "keywords",
    "repository",
    "bugs",
    "homepage",
    "type",
    "engines"
  ].map((key) => [key, source[key]]).filter(([, value]) => value !== undefined));
  metadata.bin = { "claude-codex-review-bridge": "scripts/npm-bootstrap.mjs" };
  metadata.files = ["scripts/npm-bootstrap.mjs", "docs/", ".github/CONTRIBUTING.md", ".github/SECURITY.md"];
  metadata.publishConfig = { access: "public" };

  fs.rmSync(packageRoot, { recursive: true, force: true });
  fs.mkdirSync(packageRoot, { recursive: true });
  for (const relative of copiedPaths) {
    const sourcePath = path.join(repositoryRoot, relative);
    const destinationPath = path.join(packageRoot, relative);
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    fs.cpSync(sourcePath, destinationPath, { recursive: true });
  }
  fs.writeFileSync(path.join(packageRoot, "package.json"), `${JSON.stringify(metadata, null, 2)}\n`);
  if (process.platform !== "win32") fs.chmodSync(path.join(packageRoot, "scripts", "npm-bootstrap.mjs"), 0o755);
  return metadata;
}

const invokedDirectly = process.argv[1]
  && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const metadata = stageNpmPackage();
  console.log(`Staged ${metadata.name}@${metadata.version} in ${packageRoot}`);
}
