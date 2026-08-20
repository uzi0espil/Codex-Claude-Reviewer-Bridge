import { ServerResponse } from "node:http";

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

export type StreamedJsonResponse = {
  finish: (value: unknown) => void;
};

/**
 * Starts a JSON response immediately, then keeps it alive with JSON-compatible
 * whitespace until the final value is available.
 */
export function startStreamedJsonResponse(
  response: ServerResponse,
  heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS
): StreamedJsonResponse {
  response.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-cache, no-transform"
  });
  response.flushHeaders();

  const heartbeat = setInterval(() => {
    if (!response.destroyed && !response.writableEnded) response.write("\n");
  }, heartbeatIntervalMs);
  heartbeat.unref();

  let finished = false;
  const cleanup = (): void => clearInterval(heartbeat);
  response.once("close", cleanup);

  return {
    finish(value: unknown): void {
      if (finished) return;
      finished = true;
      cleanup();
      response.removeListener("close", cleanup);
      if (!response.destroyed && !response.writableEnded) response.end(JSON.stringify(value));
    }
  };
}
