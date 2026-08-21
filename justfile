set default-list
set positional-arguments

# Node script recipes keep every argument boundary intact on all supported operating systems.
runner := '''
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { spawnSync } = require("node:child_process");

const recipe = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const stripJustDelimiter = (values) => values[0] === "--" ? values.slice(1) : values;

async function runReviewer(values) {
  const cli = pathToFileURL(path.resolve("scripts/reviewer.mjs")).href;
  const { main } = await import(cli);
  await main(values);
}

function runNpm(script) {
  const command = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(command, ["run", script], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

(async () => {
  switch (recipe) {
    case "create":
      return runReviewer(["create", "--project-root", args[0], ...stripJustDelimiter(args.slice(1))]);
    case "setup":
      return runReviewer(["setup", "--project-root", args[0], ...stripJustDelimiter(args.slice(1))]);
    case "login":
      return runReviewer(["login", ...stripJustDelimiter(args)]);
    case "policy":
      return runReviewer(["policy", ...args]);
    case "pair":
      return runReviewer(["start-pair", "--feature", args[0], ...args.slice(1)]);
    case "server":
      return runReviewer(["ensure"]);
    case "stop":
      return runReviewer(["stop"]);
    case "update":
      return runReviewer(["update", ...stripJustDelimiter(args)]);
    case "reviewer":
      return runReviewer(stripJustDelimiter(args));
    case "test":
    case "check":
      return runNpm(recipe);
    default:
      throw new Error(`Unknown recipe: ${recipe}`);
  }
})().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
'''

# Clone and initialize an isolated reviewer for an application repository.
[script("node")]
create project_root *options:
    {{ runner }}

# Bind this reviewer to an application repository and install dependencies.
[script("node")]
setup project_root *options:
    {{ runner }}

# Authenticate the isolated Codex home.
[script("node")]
login *options:
    {{ runner }}

# Create or refresh the private application review policy.
[script("node")]
policy *codex_args:
    {{ runner }}

# Open the paired Claude and Codex terminals for a feature.
[script("node")]
pair feature *claude_args:
    {{ runner }}

# Ensure the local review bridge server is running.
[script("node")]
server:
    {{ runner }}

# Gracefully stop the local review bridge server.
[script("node")]
stop:
    {{ runner }}

# Fast-forward and reconfigure this reviewer instance.
[script("node")]
update *options:
    {{ runner }}

# Run any reviewer CLI command directly.
[script("node")]
reviewer *args:
    {{ runner }}

# Run the complete test suite.
[script("node")]
test:
    {{ runner }}

# Type-check the bridge without emitting files.
[script("node")]
check:
    {{ runner }}
