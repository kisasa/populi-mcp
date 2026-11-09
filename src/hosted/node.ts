import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { MAX_BODY_BYTES } from "./server.js";

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v)?.split(",")[0]?.trim();

async function toRequest(req: IncomingMessage): Promise<Request | "too-large"> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES + 1024) return "too-large";
    chunks.push(chunk as Buffer);
  }
  // behind a TLS-terminating proxy (Lambda function URL, CloudFront, a load balancer) the original scheme is in x-forwarded-proto
  const proto = first(req.headers["x-forwarded-proto"]) ?? "http";
  const host = first(req.headers["x-forwarded-host"]) ?? req.headers.host ?? "localhost";
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) for (const v of value) headers.append(name, v);
    else if (value !== undefined) headers.set(name, value);
  }
  const method = req.method ?? "GET";
  return new Request(`${proto}://${host}${req.url ?? "/"}`, {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : Buffer.concat(chunks),
  });
}

async function respond(handler: (req: Request) => Promise<Response>, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const request = await toRequest(req);
    if (request === "too-large") {
      res.writeHead(413, { "content-type": "application/json" }).end('{"error":"request_too_large"}');
      return;
    }
    const response = await handler(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    if (!res.headersSent) res.writeHead(400, { "content-type": "application/json" });
    res.end('{"error":"bad_request"}');
  }
}

/** Serves a fetch-style handler on a plain Node HTTP server (a container, a laptop, or Lambda behind the Web Adapter). */
export function listen(handler: (req: Request) => Promise<Response>, port: number, host = "0.0.0.0"): Promise<Server> {
  const server = createServer((req, res) => void respond(handler, req, res));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}
