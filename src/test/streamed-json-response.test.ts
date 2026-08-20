import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { startStreamedJsonResponse, StreamedJsonResponse } from "../streamed-json-response.js";

test("streamed JSON flushes headers, heartbeats, and finishes with valid JSON", async () => {
  let stream: StreamedJsonResponse | undefined;
  const server = http.createServer((_request, response) => {
    stream = startStreamedJsonResponse(response, 10);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");

    const response = await fetch(`http://127.0.0.1:${address.port}`, {
      signal: AbortSignal.timeout(1_000)
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^application\/json/);

    await new Promise((resolve) => setTimeout(resolve, 35));
    assert.ok(stream);
    stream.finish({ kind: "feedback", text: "Review complete." });

    const body = await response.text();
    assert.match(body, /^\s+\{/);
    assert.deepEqual(JSON.parse(body), { kind: "feedback", text: "Review complete." });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});
