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

    await new Promise<void>((resolve, reject) => {
      const request = http.get(`http://127.0.0.1:${address.port}`, (response) => {
        try {
          assert.equal(response.statusCode, 200);
          assert.match(String(response.headers["content-type"] ?? ""), /^application\/json/);
        } catch (error) {
          reject(error);
          return;
        }

        response.setEncoding("utf8");
        let body = "";
        response.on("data", (chunk: string) => { body += chunk; });
        response.once("data", (heartbeat: string) => {
          try {
            assert.match(heartbeat, /^\s+$/);
            assert.ok(stream);
            stream.finish({ kind: "feedback", text: "Review complete." });
          } catch (error) {
            reject(error);
          }
        });
        response.once("end", () => {
          try {
            assert.match(body, /^\s+\{/);
            assert.deepEqual(JSON.parse(body), { kind: "feedback", text: "Review complete." });
            resolve();
          } catch (error) {
            reject(error);
          }
        });
      });
      request.setTimeout(10_000, () => request.destroy(new Error("Timed out waiting for streamed JSON.")));
      request.once("error", reject);
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});
