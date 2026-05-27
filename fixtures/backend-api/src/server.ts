import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const USERS = Object.freeze([
  Object.freeze({ id: "u_1", name: "Ada Lovelace" }),
  Object.freeze({ id: "u_2", name: "Grace Hopper" }),
]);

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

export function routeApiRequest(req, res) {
  const requestUrl = new URL(req.url || "/", "http://localhost");

  if (req.method === "GET" && requestUrl.pathname === "/health") {
    sendJson(res, 200, { status: "ok" });
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/users") {
    sendJson(res, 200, { users: USERS });
    return;
  }

  sendJson(res, 404, { error: "not_found" });
}

export function createApiServer() {
  return createServer(routeApiRequest);
}

export function startApiServer(options = {}) {
  const port = Number(options.port ?? 0);
  const host = options.host || "127.0.0.1";
  const server = createApiServer();

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      const address = server.address();
      resolve({
        server,
        url: `http://${address.address}:${address.port}`,
      });
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  const { server, url } = await startApiServer({ port });
  console.log(`backend-api fixture listening on ${url}`);

  const shutdown = () => {
    server.close(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
