import fs from "node:fs";
import { endpointPath } from "./paths.js";
import { EndpointFile } from "./types.js";

export function endpoint(): EndpointFile {
  return JSON.parse(fs.readFileSync(endpointPath, "utf8")) as EndpointFile;
}

export async function bridgeRequest<T = any>(route: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const current = endpoint();
  const response = await fetch(`${current.url}${route}`, {
    method: "POST",
    headers: { authorization: `Bearer ${current.token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal
  });
  const result = await response.json() as any;
  if (!response.ok) throw new Error(result.error ?? `Bridge returned HTTP ${response.status}.`);
  return result as T;
}
