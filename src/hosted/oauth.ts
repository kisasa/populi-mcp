import { timingSafeEqual } from "node:crypto";
import { PopuliClient, PopuliError } from "../lib/client.js";
import { ConfigError, normalizeBaseUrl } from "../lib/config.js";
import { hostAllowed, redirectAllowed, type HostedConfig } from "./config.js";
import { pkceChallenge, type TokenBox } from "./tokens.js";

export const CODE_TTL = 5 * 60;
export const ACCESS_TTL = 60 * 60;
export const REFRESH_TTL = 30 * 24 * 60 * 60;
const CLIENT_TTL = 2 * 365 * 24 * 60 * 60;
const MAX_FORM_BYTES = 16 * 1024;

/** What a signed-in person's tokens carry: their Populi instance, their API key, and whether they opted in to writes. */
export interface Creds {
  u: string;
  k: string;
  w: boolean;
}

interface ClientRecord {
  ru: string[];
  n: string;
}

interface CodeRecord extends Creds {
  cid: string;
  ru: string;
  cc: string;
}

interface AuthParams {
  clientId: string;
  clientName: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type, mcp-protocol-version, mcp-session-id",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-expose-headers": "www-authenticate",
};

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS, ...headers },
  });
}

function oauthError(error: string, description: string, status = 400): Response {
  return json(status, { error, error_description: description });
}

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function page(status: number, title: string, body: string): Response {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  body{font:16px/1.5 system-ui,sans-serif;max-width:30rem;margin:3rem auto;padding:0 1rem;color:#1a1a1a}
  h1{font-size:1.4rem} label{display:block;margin:1rem 0 .25rem;font-weight:600}
  input[type=text],input[type=url],input[type=password]{width:100%;padding:.55rem;font:inherit;box-sizing:border-box}
  .check{display:flex;gap:.5rem;align-items:flex-start;margin-top:1rem} .check label{margin:0;font-weight:400}
  button{margin-top:1.5rem;padding:.6rem 1.2rem;font:inherit;cursor:pointer}
  .error{background:#fde8e8;border:1px solid #e0a0a0;padding:.6rem .8rem;border-radius:4px}
  .muted{color:#555;font-size:.9rem}
</style></head><body>${body}</body></html>`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
      // no form-action: browsers apply it to the redirect back to the client after the form posts
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
    },
  });
}

function equal(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

async function readText(req: Request, max: number): Promise<string | undefined> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > max) return undefined;
  const text = await req.text();
  return text.length > max ? undefined : text;
}

async function readParams(req: Request): Promise<URLSearchParams | undefined> {
  const text = await readText(req, MAX_FORM_BYTES);
  if (text === undefined) return undefined;
  if ((req.headers.get("content-type") ?? "").includes("application/json")) {
    try {
      const obj = JSON.parse(text) as Record<string, unknown>;
      return new URLSearchParams(Object.entries(obj).map(([k, v]) => [k, String(v)]));
    } catch {
      return undefined;
    }
  }
  return new URLSearchParams(text);
}

export interface OAuthDeps {
  config: HostedConfig;
  tokens: TokenBox;
  fetch?: typeof fetch;
}

/** The OAuth 2.1 endpoints Claude and ChatGPT connectors use: discovery, client registration, authorize (the connect page) and token. */
export class OAuthServer {
  constructor(private readonly deps: OAuthDeps) {}

  /** Handles the request when it is an OAuth route, otherwise returns undefined. */
  async handle(req: Request, base: string): Promise<Response | undefined> {
    const { pathname } = new URL(req.url);
    const oauthPath =
      pathname.startsWith("/.well-known/oauth-protected-resource") ||
      pathname.startsWith("/.well-known/oauth-authorization-server") ||
      pathname.startsWith("/.well-known/openid-configuration") ||
      ["/register", "/authorize", "/token"].includes(pathname);
    if (!oauthPath) return undefined;

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    if (pathname.startsWith("/.well-known/oauth-protected-resource")) {
      return json(200, {
        resource: `${base}/mcp`,
        authorization_servers: [base],
        bearer_methods_supported: ["header"],
        scopes_supported: ["populi"],
      });
    }
    if (pathname.startsWith("/.well-known/")) {
      return json(200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        scopes_supported: ["populi"],
      });
    }
    if (pathname === "/register") return req.method === "POST" ? this.register(req) : json(405, { error: "method_not_allowed" });
    if (pathname === "/token") return req.method === "POST" ? this.token(req) : json(405, { error: "method_not_allowed" });
    if (req.method === "GET") return this.authorizeForm(req);
    if (req.method === "POST") return this.authorizeSubmit(req, base);
    return json(405, { error: "method_not_allowed" });
  }

  /** The signed-in person's credentials from an `Authorization: Bearer` header, or undefined. */
  authenticate(req: Request): Creds | undefined {
    const header = req.headers.get("authorization") ?? "";
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    if (!match) return undefined;
    const payload = this.deps.tokens.open<Record<string, unknown>>("access", match[1]!);
    return payload && this.asCreds(payload);
  }

  private asCreds(p: Record<string, unknown>): Creds | undefined {
    return typeof p.u === "string" && typeof p.k === "string" ? { u: p.u, k: p.k, w: p.w === true } : undefined;
  }

  // RFC 7591 dynamic client registration. Stateless: the client id is a sealed copy of the registration.
  private async register(req: Request): Promise<Response> {
    const text = await readText(req, MAX_FORM_BYTES);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(text ?? "") as Record<string, unknown>;
    } catch {
      return oauthError("invalid_client_metadata", "Send a JSON registration request.");
    }
    const uris = body.redirect_uris;
    if (!Array.isArray(uris) || uris.length < 1 || uris.length > 5 || !uris.every((u) => typeof u === "string")) {
      return oauthError("invalid_redirect_uri", "redirect_uris must be a list of 1 to 5 URLs.");
    }
    for (const uri of uris as string[]) {
      if (!redirectAllowed(uri, this.deps.config.redirectRules)) {
        return oauthError("invalid_redirect_uri", `Redirect URI not allowed by this server: ${uri}`);
      }
    }
    const name = typeof body.client_name === "string" && body.client_name.trim() ? body.client_name.trim().slice(0, 100) : "An application";
    const record: ClientRecord = { ru: uris as string[], n: name };
    return json(201, {
      client_id: this.deps.tokens.seal("client", { ...record }, CLIENT_TTL),
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: name,
      redirect_uris: uris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
  }

  /** Validates the authorize request. Problems with the client or redirect are shown, never redirected to. */
  private parseAuthorize(params: URLSearchParams): AuthParams | Response {
    const clientId = params.get("client_id") ?? "";
    const client = this.deps.tokens.open<Record<string, unknown>>("client", clientId);
    if (!client || !Array.isArray(client.ru)) {
      return page(
        400,
        "Unknown application",
        "<h1>Can't connect</h1><p>This application isn't registered with the server, or its registration expired. Remove the connector and add it again.</p>",
      );
    }
    const redirectUri = params.get("redirect_uri") ?? "";
    if (!(client.ru as string[]).includes(redirectUri) || !redirectAllowed(redirectUri, this.deps.config.redirectRules)) {
      return page(400, "Invalid redirect", "<h1>Can't connect</h1><p>The return address in this request isn't allowed.</p>");
    }
    const state = params.get("state") ?? "";
    const back = (error: string, description: string): Response => {
      const to = new URL(redirectUri);
      to.searchParams.set("error", error);
      to.searchParams.set("error_description", description);
      if (state) to.searchParams.set("state", state);
      return new Response(null, { status: 302, headers: { location: to.toString(), "cache-control": "no-store" } });
    };
    if (params.get("response_type") !== "code") return back("unsupported_response_type", "Only response_type=code is supported.");
    const challenge = params.get("code_challenge") ?? "";
    if (!challenge || params.get("code_challenge_method") !== "S256") {
      return back("invalid_request", "PKCE with code_challenge_method=S256 is required.");
    }
    return {
      clientId,
      clientName: typeof client.n === "string" ? client.n : "An application",
      redirectUri,
      codeChallenge: challenge,
      state,
    };
  }

  private form(a: AuthParams, opts: { baseUrlInput?: string; error?: string; writes?: boolean } = {}): Response {
    const pinned = this.deps.config.baseUrl;
    const returnHost = new URL(a.redirectUri).host || new URL(a.redirectUri).protocol;
    const hidden = (name: string, value: string): string => `<input type="hidden" name="${name}" value="${esc(value)}">`;
    const instance = pinned
      ? `<p class="muted">Instance: <strong>${esc(new URL(pinned).host)}</strong></p>`
      : `<label for="base_url">Populi address</label>
         <input id="base_url" name="base_url" type="url" required placeholder="https://yourschool.populiweb.com" value="${esc(opts.baseUrlInput ?? "")}">`;
    const writes = this.deps.config.allowWrites
      ? `<div class="check"><input id="allow_writes" name="allow_writes" type="checkbox"${opts.writes ? " checked" : ""}>
         <label for="allow_writes">Also allow creating, updating and deleting records (leave unticked for read-only)</label></div>`
      : "";
    return page(
      opts.error ? 400 : 200,
      "Connect to Populi",
      `<h1>Connect to Populi</h1>
       <p><strong>${esc(a.clientName)}</strong> wants to use Populi on your behalf, and will return to <strong>${esc(returnHost)}</strong>.</p>
       ${opts.error ? `<p class="error">${esc(opts.error)}</p>` : ""}
       <form method="post" action="/authorize" autocomplete="off">
         ${hidden("client_id", a.clientId)}${hidden("redirect_uri", a.redirectUri)}${hidden("code_challenge", a.codeChallenge)}${hidden("state", a.state)}${hidden("response_type", "code")}${hidden("code_challenge_method", "S256")}
         ${instance}
         <label for="api_key">Your Populi API key</label>
         <input id="api_key" name="api_key" type="password" required autocomplete="off" spellcheck="false">
         <p class="muted">In Populi: Account &amp; Settings &gt; API &gt; Keys. The key limits what you can see and do, exactly as in Populi itself. It is stored only inside the encrypted token your AI app holds.</p>
         ${writes}
         <button type="submit">Connect</button>
       </form>`,
    );
  }

  private authorizeForm(req: Request): Response {
    const parsed = this.parseAuthorize(new URL(req.url).searchParams);
    return parsed instanceof Response ? parsed : this.form(parsed);
  }

  private async authorizeSubmit(req: Request, base: string): Promise<Response> {
    const origin = req.headers.get("origin");
    if (origin && origin !== "null" && new URL(origin).host !== new URL(base).host) {
      return page(403, "Blocked", "<h1>Blocked</h1><p>This form must be submitted from this site.</p>");
    }
    const params = await readParams(req);
    if (!params) return page(400, "Bad request", "<h1>Bad request</h1>");
    const parsed = this.parseAuthorize(params);
    if (parsed instanceof Response) return parsed;

    const apiKey = (params.get("api_key") ?? "").trim();
    const baseInput = (params.get("base_url") ?? "").trim();
    const writes = this.deps.config.allowWrites && params.get("allow_writes") === "on";
    const redo = (error: string): Response => this.form(parsed, { baseUrlInput: baseInput, error, writes });
    if (!apiKey) return redo("Enter your Populi API key.");

    let baseUrl: string;
    if (this.deps.config.baseUrl) {
      baseUrl = this.deps.config.baseUrl;
    } else {
      try {
        baseUrl = normalizeBaseUrl(baseInput);
      } catch (err) {
        return redo(err instanceof ConfigError ? err.message.replace(/POPULI_BASE_URL/g, "The address") : "Enter your Populi address.");
      }
      if (!hostAllowed(new URL(baseUrl).hostname, this.deps.config.allowedHosts)) {
        return redo(`That address isn't one this server is set up to connect to (${this.deps.config.allowedHosts.join(", ")}).`);
      }
    }

    const problem = await this.checkKey(baseUrl, apiKey);
    if (problem) return redo(problem);

    const record: CodeRecord = { cid: parsed.clientId, ru: parsed.redirectUri, cc: parsed.codeChallenge, u: baseUrl, k: apiKey, w: writes };
    const to = new URL(parsed.redirectUri);
    to.searchParams.set("code", this.deps.tokens.seal("code", { ...record }, CODE_TTL));
    if (parsed.state) to.searchParams.set("state", parsed.state);
    return new Response(null, { status: 302, headers: { location: to.toString(), "cache-control": "no-store" } });
  }

  /** One live request, so a typo shows up on the connect page instead of as a broken connector later. */
  private async checkKey(baseUrl: string, apiKey: string): Promise<string | undefined> {
    const client = new PopuliClient(
      { baseUrl, apiKey, timeoutMs: Math.min(this.deps.config.timeoutMs, 20_000) },
      this.deps.fetch ?? fetch,
    );
    try {
      await client.request({ method: "GET", path: "/people", params: { limit: 1 } });
      return undefined;
    } catch (err) {
      if (err instanceof PopuliError) {
        // 403: the key works but its role can't list people, which doesn't make it a bad key
        if (err.status === 403) return undefined;
        if (err.status === 401) return "Populi rejected that API key. Check that it is copied in full and belongs to this instance.";
        return `Populi answered with an error: ${err.message}`;
      }
      return "Could not check the key with Populi. Try again in a moment.";
    }
  }

  private async token(req: Request): Promise<Response> {
    const params = await readParams(req);
    if (!params) return oauthError("invalid_request", "Send the token request as a form or JSON body.");
    const grant = params.get("grant_type");
    const { tokens } = this.deps;

    let creds: Creds | undefined;
    let clientId: string;
    if (grant === "authorization_code") {
      const code = tokens.open<Record<string, unknown>>("code", params.get("code") ?? "");
      if (!code) return oauthError("invalid_grant", "The authorization code is invalid or has expired.");
      clientId = params.get("client_id") ?? "";
      const verifier = params.get("code_verifier") ?? "";
      if (code.cid !== clientId || code.ru !== (params.get("redirect_uri") ?? "")) {
        return oauthError("invalid_grant", "client_id or redirect_uri does not match the authorization request.");
      }
      if (!verifier || typeof code.cc !== "string" || !equal(pkceChallenge(verifier), code.cc)) {
        return oauthError("invalid_grant", "PKCE verification failed.");
      }
      creds = this.asCreds(code);
    } else if (grant === "refresh_token") {
      const refresh = tokens.open<Record<string, unknown>>("refresh", params.get("refresh_token") ?? "");
      if (!refresh) return oauthError("invalid_grant", "The refresh token is invalid or has expired.");
      clientId = typeof refresh.cid === "string" ? refresh.cid : "";
      const given = params.get("client_id");
      if (given && given !== clientId) return oauthError("invalid_grant", "client_id does not match the refresh token.");
      creds = this.asCreds(refresh);
    } else {
      return oauthError("unsupported_grant_type", "Use authorization_code or refresh_token.");
    }
    if (!creds) return oauthError("invalid_grant", "The grant carries no credentials.");

    return json(200, {
      access_token: tokens.seal("access", { ...creds }, ACCESS_TTL),
      token_type: "Bearer",
      expires_in: ACCESS_TTL,
      refresh_token: tokens.seal("refresh", { cid: clientId, ...creds }, REFRESH_TTL),
      scope: "populi",
    });
  }
}
