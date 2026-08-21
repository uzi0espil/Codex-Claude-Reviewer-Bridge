import fs from "node:fs";
import path from "node:path";
import { reviewerRoot } from "./paths.js";

const metadata = JSON.parse(fs.readFileSync(path.join(reviewerRoot, "package.json"), "utf8")) as {
  version?: unknown;
};

if (typeof metadata.version !== "string" || !metadata.version) {
  throw new Error("package.json does not contain a valid bridge version.");
}

export const bridgeVersion = metadata.version;
