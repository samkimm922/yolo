import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
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

type ApiServerHandle = {
  server: ReturnType<typeof createApiServer>;
  url: string;
};

export function startApiServer(options = Object()): Promise<ApiServerHandle> {
  const port = Number(options.port ?? 0);
  const host = options.host || "127.0.0.1";
  const server = createApiServer();

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      const address = server.address();
      if (typeof address === "string" || address === null) {
        reject(new Error("backend-api fixture did not bind to a TCP address"));
        return;
      }
      const tcpAddress: AddressInfo = address;
      resolve({
        server,
        url: `http://${tcpAddress.address}:${tcpAddress.port}`,
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
