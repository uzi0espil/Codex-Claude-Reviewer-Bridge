import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { loadBoundProjectRoot } from "./review-tools.js";
import { discoverReviewTools } from "./review-tools-discovery.js";
import { reviewToolsDetectionPath } from "./review-tools-store.js";

const projectRoot = process.argv[2] ? path.resolve(process.argv[2]) : loadBoundProjectRoot();
const outputPath = process.argv[3] ? path.resolve(process.argv[3]) : reviewToolsDetectionPath;
const discovery = discoverReviewTools(projectRoot);
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(discovery, null, 2)}\n`, "utf8");
console.log(`Detected ${discovery.candidates.length} review-tool candidates, ${discovery.requirements.filter(({ role }) => role === "validation").length} CI validation requirements, and ${discovery.requirements.filter(({ role }) => role === "support").length} CI support steps across ${discovery.technologies.length} technology surfaces.`);
console.log(`Wrote ${outputPath}`);
