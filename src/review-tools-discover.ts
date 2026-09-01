import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { reviewerRoot } from "./paths.js";
import { loadBoundProjectRoot } from "./review-tools.js";
import { discoverReviewTools } from "./review-tools-discovery.js";

const projectRoot = process.argv[2] ? path.resolve(process.argv[2]) : loadBoundProjectRoot();
const outputPath = process.argv[3] ? path.resolve(process.argv[3]) : path.join(reviewerRoot, "review-tools.detected.json");
const discovery = discoverReviewTools(projectRoot);
fs.writeFileSync(outputPath, `${JSON.stringify(discovery, null, 2)}\n`, "utf8");
console.log(`Detected ${discovery.candidates.length} review-tool candidates across ${discovery.technologies.length} technology surfaces.`);
console.log(`Wrote ${outputPath}`);

