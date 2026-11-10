import { createHash } from "node:crypto";
import {
  createMcpHandler,
  isLegacyRequest,
  WebStandardStreamableHTTPServerTransport,
  type AuthInfo,
  type McpServer,
} from "@modelcontextprotocol/server";
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

    // Read the body once, from a clone, so the era check and the guards below don't drain the request.
    const raw = await req.clone().text();
    if (raw.length > MAX_BODY_BYTES) return json(413, { error: "request_too_large" });
    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(raw);
    } catch {
      // left undefined: the SDK reads the body itself and answers with a proper parse error
    }
    const message = parsedBody as { method?: unknown; id?: unknown } | undefined;
    if (message?.method === "subscriptions/listen") {
      // A listen stream stays open until the client leaves, which a buffered host (Lambda) can't
      // serve. The tool list never changes mid-connection, so there is nothing to listen for.
      return json(200, {
        jsonrpc: "2.0",
        id: message.id ?? null,
        error: { code: -32601, message: "This server sends no change notifications; subscriptions/listen is not supported." },
      });
    }

    const authInfo: AuthInfo = { token: "", clientId: "populi-mcp", scopes: ["populi"], extra: { config: cfg } };
    if (await isLegacyRequest(req, parsedBody, { maxRequestBodySize: MAX_BODY_BYTES })) {
      // 2025-era clients (initialize handshake): a fresh stateless transport per request, plain JSON replies
      const server = serverFor(cfg);
      const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true, maxRequestBodySize: MAX_BODY_BYTES });
      await server.connect(transport);
      try {
        return await transport.handleRequest(req, { parsedBody, authInfo });
      } finally {
        void server.close();
      }
    }
    // 2026-07-28 clients: every request is self-contained, no initialize and no session
    return modern.fetch(req, { parsedBody, authInfo });
  }

  function serverFor(cfg: Config): McpServer {
    const server = createServer(cfg, deps.version, { client: clientFor(cfg), catalog });
    // No mid-connection tool changes, so don't invite clients to open a listen stream for them.
    server.server.registerCapabilities({ tools: { listChanged: false } });
    return server;
  }

  const modern = createMcpHandler(
    (ctx) => {
      const cfg = (ctx.authInfo?.extra as { config?: Config } | undefined)?.config;
      if (!cfg) throw new Error("No credentials for this request.");
      return serverFor(cfg);
    },
    { legacy: "reject", responseMode: "json", maxRequestBodySize: MAX_BODY_BYTES },
  );

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
