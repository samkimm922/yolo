import { test } from "node:test";
import assert from "node:assert/strict";
import { startApiServer } from "../src/server.ts";

async function withServer(assertions) {
  const { server, url } = await startApiServer();
  try {
    await assertions(url);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

test("GET /health returns an ok status", async () => {
  await withServer(async (url) => {
    const response = await fetch(`${url}/health`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /^application\/json/);
    assert.deepEqual(await response.json(), { status: "ok" });
  });
});

test("GET /api/users returns the fixture users", async () => {
  await withServer(async (url) => {
    const response = await fetch(`${url}/api/users`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      users: [
        { id: "u_1", name: "Ada Lovelace" },
        { id: "u_2", name: "Grace Hopper" },
      ],
    });
  });
});

test("unknown API routes fail closed", async () => {
  await withServer(async (url) => {
    const response = await fetch(`${url}/missing`);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "not_found" });
  });
});
