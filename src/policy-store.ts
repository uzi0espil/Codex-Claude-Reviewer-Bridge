import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { localReviewPolicyPath } from "./paths.js";

export const maxReviewPolicyBytes = 65_536;

export type PolicyWriteResult = {
  path: string;
  sha256: string;
  bytes: number;
  created: boolean;
};

function hash(value: Buffer | string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function readPolicyFile(filename = localReviewPolicyPath): { content: string; sha256: string } | undefined {
  if (!fs.existsSync(filename)) return undefined;
  const content = fs.readFileSync(filename, "utf8");
  return { content, sha256: hash(Buffer.from(content, "utf8")) };
}

export function writePolicyFile(
  content: string,
  expectedSha256: string | null,
  filename = localReviewPolicyPath
): PolicyWriteResult {
  const normalized = content.trim();
  if (!normalized) throw new Error("Review policy content cannot be empty.");

  const encoded = Buffer.from(`${normalized}\n`, "utf8");
  if (encoded.byteLength > maxReviewPolicyBytes) {
    throw new Error(`Review policy exceeds the ${maxReviewPolicyBytes}-byte limit.`);
  }

  const existing = readPolicyFile(filename);
  const actualHash = existing?.sha256 ?? null;
  const normalizedExpectedHash = expectedSha256?.toLowerCase() ?? null;
  if (actualHash !== normalizedExpectedHash) {
    throw new Error(
      `Review policy changed since it was inspected (expected ${expectedSha256 ?? "no file"}, found ${actualHash ?? "no file"}). Re-read it and review the updated diff before saving.`
    );
  }

  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = path.join(
    path.dirname(filename),
    `.${path.basename(filename)}.${process.pid}.${crypto.randomUUID()}.tmp`
  );
  try {
    fs.writeFileSync(temporary, encoded, { encoding: "utf8", flag: "wx" });
    fs.renameSync(temporary, filename);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }

  return {
    path: filename,
    sha256: hash(encoded),
    bytes: encoded.byteLength,
    created: !existing
  };
}
