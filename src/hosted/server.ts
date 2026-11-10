import { createHash } from "node:crypto";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Catalog } from "../lib/catalog.js";
import { PopuliClient } from "../lib/client.js";
import type { Config } from "../lib/config.js";
import { createServer } from "../server.js";
import { hostAllowed, type HostedConfig } from "./config.js";
import { json, OAuthServer, type Creds } from "./oauth.js";
import { TokenBox } from "./tokens.js";

/** Largest request body the server accepts. Many hosts cap bodies at a few MB, and uploads travel as base64. */
export const MAX_BODY_BYTES = 5 * 1024 * 1024;

const CLIENT_IDLE_MS = 10 * 60_000;
const MAX_CLIENTS = 100;

export interface HostedDeps {
  config: HostedConfig;
  version: string;
  fetch?: typeof fetch;
  catalog?: Catalog;
  /** Per-request log line sink. Never receives bodies, tokens or keys. */
  log?: (line: string) => void;
}

/**
 * A fetch-style handler (Request in, Response out) serving the OAuth endpoints and a stateless
 * MCP endpoint at /mcp. Each request carries the caller's own encrypted credentials, so one
 * deployment serves many people without storing anything.
 */
export function createHostedHandler(deps: HostedDeps): (req: Request) => Promise<Response> {
  const { config } = deps;
  const tokens = new TokenBox(config.secrets);
  const oauth = new OAuthServer({ config, tokens, fetch: deps.fetch });
  const catalog = deps.catalog ?? Catalog.load();

  // Keeping the Populi client between requests keeps its one-at-a-time queue and its 429 backoff
  // working for as long as this instance stays warm.
  const clients = new Map<string, { client: PopuliClient; used: number }>();
  function clientFor(cfg: Config): PopuliClient {
    const now = Date.now();
    for (const [key, entry] of clients) if (now - entry.used > CLIENT_IDLE_MS) clients.delete(key);
    const key = createHash("sha256").update(`${cfg.baseUrl}\0${cfg.apiKey}`).digest("hex");
    let entry = clients.get(key);
    if (!entry) {
      if (clients.size >= MAX_CLIENTS) clients.delete(clients.keys().next().value as string);
      entry = { client: new PopuliClient(cfg, deps.fetch), used: now };
      clients.set(key, entry);
    }
    entry.used = now;
    return entry.client;
  }

  function configFor(creds: Creds): Config | undefined {
    // Tokens issued for another instance stop working if the deployment is pinned to a different one.
    if (config.baseUrl ? creds.u !== config.baseUrl : !hostAllowed(new URL(creds.u).hostname, config.allowedHosts)) return undefined;
    return {
      baseUrl: creds.u,
      apiKey: creds.k,
      allowWrites: config.allowWrites && creds.w,
      sandbox: creds.k.startsWith("sk_sandbox_"),
      filesDir: "",
      filesMode: "inline",
      timeoutMs: config.timeoutMs,
    };
  }

  async function mcp(req: Request, base: string): Promise<Response> {
    if (req.method === "OPTIONS") return oauthPreflight();
    if (req.method !== "POST") {
      // stateless: there is no session to stream from or delete
      return json(
        405,
        { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed. POST JSON-RPC messages to this endpoint." }, id: null },
        { allow: "POST" },
      );
    }
    const creds = oauth.authenticate(req);
    const cfg = creds && configFor(creds);
    if (!cfg) {
      return json(
        401,
        { error: "invalid_token", error_description: "Missing, invalid or expired access token. Connect again." },
        { "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"` },
      );
    }

    const server = createServer(cfg, deps.version, { client: clientFor(cfg), catalog });
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true, maxRequestBodySize: MAX_BODY_BYTES });
    await server.connect(transport);
    try {
      return await transport.handleRequest(req);
    } finally {
      void server.close();
    }
  }

  return async (req) => {
    const started = Date.now();
    let status = 500;
    const { pathname } = new URL(req.url);
    try {
      const base = config.publicUrl ?? new URL(req.url).origin;
      let res: Response | undefined;
      if (pathname === "/healthz") res = new Response("ok", { headers: { "content-type": "text/plain" } });
      else if (pathname === "/mcp") res = await mcp(req, base);
      else res = await oauth.handle(req, base);
      res ??= json(404, { error: "not_found" });
      status = res.status;
      return res;
    } catch (err) {
      deps.log?.(`error ${req.method} ${pathname}: ${err instanceof Error ? err.name : "unknown"}`);
      return json(500, { error: "server_error" });
    } finally {
      // method, path, status and timing only: never bodies, tokens or keys
      if (pathname !== "/healthz") deps.log?.(`${req.method} ${pathname} ${status} ${Date.now() - started}ms`);
    }
  };
}

function oauthPreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "authorization, content-type, mcp-protocol-version, mcp-session-id",
      "access-control-allow-methods": "GET, POST, OPTIONS",
    },
  });
}
