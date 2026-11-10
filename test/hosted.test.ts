import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { ConfigError } from "../src/lib/config.js";
import { DEFAULT_REDIRECT_RULES, hostAllowed, loadHostedConfig, redirectAllowed, type HostedConfig } from "../src/hosted/config.js";
import { listen } from "../src/hosted/node.js";
import { createHostedHandler } from "../src/hosted/server.js";
import { pkceChallenge, TokenBox } from "../src/hosted/tokens.js";
import { fakeFetch, jsonResponse, type Reply } from "./helpers.js";

const SECRET = "s".repeat(40);
const BASE = "https://mcp.example.edu";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const VERIFIER = "v".repeat(60);
const KEY = "sk_live_abcdef";
const INSTANCE = "https://school.populiweb.com";

function hostedConfig(over: Partial<HostedConfig> = {}): HostedConfig {
  return {
    port: 0,
    secrets: [SECRET],
    publicUrl: BASE,
    baseUrl: undefined,
    allowedHosts: ["populiweb.com", "populi.co"],
    allowWrites: false,
    redirectRules: DEFAULT_REDIRECT_RULES,
    timeoutMs: 5000,
    ...over,
  };
}

const people = () => jsonResponse({ object: "list", count: 1, data: [{ id: 7, first_name: "Ada" }] });

function setup(over: Partial<HostedConfig> = {}, ...replies: Reply[]) {
  const populi = fakeFetch(...(replies.length ? replies : [people()]));
  const handler = createHostedHandler({ config: hostedConfig(over), version: "0.0.0-test", fetch: populi.fetch });
  return { handler, populi };
}

type Handler = ReturnType<typeof setup>["handler"];

const post = (path: string, body: string | Record<string, unknown>, headers: Record<string, string> = {}) =>
  new Request(`${BASE}${path}`, {
    method: "POST",
    headers: typeof body === "string" ? { "content-type": "application/x-www-form-urlencoded", ...headers } : { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

async function register(handler: Handler, redirect = REDIRECT): Promise<string> {
  const res = await handler(post("/register", { redirect_uris: [redirect], client_name: "Claude" }));
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

function authorizeUrl(clientId: string, extra: Record<string, string> = {}): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: pkceChallenge(VERIFIER),
    code_challenge_method: "S256",
    state: "st-1",
    ...extra,
  });
  return `${BASE}/authorize?${q}`;
}

function submit(clientId: string, fields: Record<string, string> = {}) {
  return post(
    "/authorize",
    new URLSearchParams({
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: pkceChallenge(VERIFIER),
      code_challenge_method: "S256",
      response_type: "code",
      state: "st-1",
      base_url: INSTANCE,
      api_key: KEY,
      ...fields,
    }).toString(),
    { origin: BASE },
  );
}

async function exchange(handler: Handler, clientId: string, code: string, over: Record<string, string> = {}) {
  return handler(
    post(
      "/token",
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_verifier: VERIFIER,
        ...over,
      }).toString(),
    ),
  );
}

/** Registers, signs in, and trades the code for tokens. */
async function signIn(handler: Handler, fields: Record<string, string> = {}) {
  const clientId = await register(handler);
  const redirect = await handler(submit(clientId, fields));
  expect(redirect.status).toBe(302);
  const to = new URL(redirect.headers.get("location")!);
  const tokenRes = await exchange(handler, clientId, to.searchParams.get("code")!);
  expect(tokenRes.status).toBe(200);
  const tokens = (await tokenRes.json()) as { access_token: string; refresh_token: string; expires_in: number };
  return { clientId, tokens };
}

async function rpc(handler: Handler, accessToken: string | undefined, method: string, params: Record<string, unknown> = {}) {
  const res = await handler(
    post(
      "/mcp",
      { jsonrpc: "2.0", id: 1, method, params },
      {
        accept: "application/json, text/event-stream",
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      },
    ),
  );
  return { res, body: res.headers.get("content-type")?.includes("json") ? ((await res.json()) as any) : undefined };
}

describe("TokenBox", () => {
  const box = new TokenBox([SECRET]);

  it("round-trips a payload and never shows it in the token", () => {
    const token = box.seal("access", { u: INSTANCE, k: "sk_live_secret" }, 60);
    expect(token).not.toContain("sk_live_secret");
    expect(box.open("access", token)).toMatchObject({ u: INSTANCE, k: "sk_live_secret" });
  });

  it("binds the type: a refresh token is not an access token", () => {
    const token = box.seal("refresh", { a: 1 }, 60);
    expect(box.open("access", token)).toBeUndefined();
    expect(box.open("refresh", token)).toBeDefined();
  });

  it("rejects tampered, truncated and foreign tokens", () => {
    const token = box.seal("access", { a: 1 }, 60);
    const flipped = token.slice(0, -2) + (token.endsWith("AA") ? "BB" : "AA");
    expect(box.open("access", flipped)).toBeUndefined();
    expect(box.open("access", token.slice(0, 20))).toBeUndefined();
    expect(box.open("access", "garbage")).toBeUndefined();
    expect(new TokenBox(["t".repeat(40)]).open("access", token)).toBeUndefined();
  });

  it("expires", () => {
    const now = Date.now();
    const token = box.seal("code", { a: 1 }, 60, now);
    expect(box.open("code", token, now + 59_000)).toBeDefined();
    expect(box.open("code", token, now + 61_000)).toBeUndefined();
  });

  it("keeps old tokens working after the secret is rotated", () => {
    const old = box.seal("access", { a: 1 }, 60);
    const rotated = new TokenBox(["n".repeat(40), SECRET]);
    expect(rotated.open("access", old)).toBeDefined();
    expect(rotated.open("access", rotated.seal("access", { a: 2 }, 60))).toBeDefined();
    expect(box.open("access", rotated.seal("access", { a: 2 }, 60))).toBeUndefined();
  });
});

describe("redirect and host checks", () => {
  it("allows the known clients and local apps", () => {
    for (const ok of [
      "https://claude.ai/api/mcp/auth_callback",
      "https://chatgpt.com/connector_platform_oauth_redirect",
      "http://localhost:54321/callback",
      "http://127.0.0.1:8123/cb",
      "cursor://anysphere.cursor-mcp/oauth/callback",
    ]) {
      expect(redirectAllowed(ok, DEFAULT_REDIRECT_RULES), ok).toBe(true);
    }
  });

  it("is structural, so tricks with userinfo, lookalike hosts and plain http fail", () => {
    for (const bad of [
      "http://localhost:1@evil.example/cb",
      "https://claude.ai.evil.example/cb",
      "https://evil.example/claude.ai",
      "http://claude.ai/cb",
      "https://claude.ai/cb#frag",
      "javascript:alert(1)",
      "not a url",
    ]) {
      expect(redirectAllowed(bad, DEFAULT_REDIRECT_RULES), bad).toBe(false);
    }
  });

  it("matches Populi hosts by suffix on a label boundary", () => {
    expect(hostAllowed("school.populiweb.com", ["populiweb.com"])).toBe(true);
    expect(hostAllowed("tsri.demo.populi.co", ["populi.co"])).toBe(true);
    expect(hostAllowed("evilpopuliweb.com", ["populiweb.com"])).toBe(false);
    expect(hostAllowed("populiweb.com.evil.example", ["populiweb.com"])).toBe(false);
  });
});

describe("loadHostedConfig", () => {
  const env = { POPULI_MCP_SECRET: SECRET };

  it("needs a long secret", () => {
    expect(() => loadHostedConfig({})).toThrow(/POPULI_MCP_SECRET/);
    expect(() => loadHostedConfig({ POPULI_MCP_SECRET: "short" })).toThrow(ConfigError);
  });

  it("has safe defaults: unpinned, read-only, Populi hosts only", () => {
    expect(loadHostedConfig(env)).toMatchObject({
      port: 8080,
      baseUrl: undefined,
      allowWrites: false,
      allowedHosts: ["populiweb.com", "populi.co"],
    });
  });

  it("pins the instance, normalizes the public URL, and lists previous secrets", () => {
    const c = loadHostedConfig({
      ...env,
      POPULI_BASE_URL: "https://school.populiweb.com",
      POPULI_MCP_PUBLIC_URL: "https://mcp.example.edu/",
      POPULI_MCP_PREVIOUS_SECRETS: "p".repeat(40),
      POPULI_ALLOW_WRITES: "true",
    });
    expect(c).toMatchObject({ baseUrl: "https://school.populiweb.com/api2", publicUrl: BASE, allowWrites: true });
    expect(c.secrets).toHaveLength(2);
  });

  it("requires https for the public URL except on localhost", () => {
    expect(() => loadHostedConfig({ ...env, POPULI_MCP_PUBLIC_URL: "http://mcp.example.edu" })).toThrow(ConfigError);
    expect(loadHostedConfig({ ...env, POPULI_MCP_PUBLIC_URL: "http://localhost:8080" }).publicUrl).toBe("http://localhost:8080");
  });
});

describe("discovery", () => {
  it("publishes protected-resource and authorization-server metadata", async () => {
    const { handler } = setup();
    const resource = (await (await handler(new Request(`${BASE}/.well-known/oauth-protected-resource/mcp`))).json()) as any;
    expect(resource).toMatchObject({ resource: `${BASE}/mcp`, authorization_servers: [BASE] });
    const meta = (await (await handler(new Request(`${BASE}/.well-known/oauth-authorization-server`))).json()) as any;
    expect(meta).toMatchObject({
      issuer: BASE,
      authorization_endpoint: `${BASE}/authorize`,
      token_endpoint: `${BASE}/token`,
      registration_endpoint: `${BASE}/register`,
      code_challenge_methods_supported: ["S256"],
    });
  });

  it("answers health checks and unknown paths", async () => {
    const { handler } = setup();
    expect((await handler(new Request(`${BASE}/healthz`))).status).toBe(200);
    expect((await handler(new Request(`${BASE}/nope`))).status).toBe(404);
  });
});

describe("client registration", () => {
  it("registers an allowed redirect and refuses others", async () => {
    const { handler } = setup();
    expect(await register(handler)).toMatch(/^pm1\./);
    const bad = await handler(post("/register", { redirect_uris: ["https://evil.example/cb"] }));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as any).error).toBe("invalid_redirect_uri");
    expect((await handler(post("/register", { redirect_uris: [] }))).status).toBe(400);
  });
});

describe("authorize", () => {
  it("shows a connect page that names the app and where it returns, and asks for the instance and key", async () => {
    const { handler } = setup();
    const clientId = await register(handler);
    const res = await handler(new Request(authorizeUrl(clientId)));
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain("Claude");
    expect(html).toContain("claude.ai");
    expect(html).toContain('name="api_key"');
    expect(html).toContain('name="base_url"');
    expect(html).not.toContain("allow_writes");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("asks only for the key when the instance is pinned, and offers writes only when enabled", async () => {
    const { handler } = setup({ baseUrl: `${INSTANCE}/api2`, allowWrites: true });
    const html = await (await handler(new Request(authorizeUrl(await register(handler))))).text();
    expect(html).not.toContain('name="base_url"');
    expect(html).toContain("school.populiweb.com");
    expect(html).toContain('name="allow_writes"');
  });

  it("refuses an unknown client or a redirect that wasn't registered, without redirecting", async () => {
    const { handler } = setup();
    const unknown = await handler(new Request(authorizeUrl("pm1.nope")));
    expect(unknown.status).toBe(400);
    expect(unknown.headers.get("location")).toBeNull();

    const clientId = await register(handler);
    const other = await handler(new Request(authorizeUrl(clientId, { redirect_uri: "https://chatgpt.com/cb" })));
    expect(other.status).toBe(400);
    expect(other.headers.get("location")).toBeNull();
  });

  it("requires PKCE S256", async () => {
    const { handler } = setup();
    const clientId = await register(handler);
    const res = await handler(new Request(authorizeUrl(clientId, { code_challenge_method: "plain" })));
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get("location")!);
    expect(to.origin + to.pathname).toBe(REDIRECT);
    expect(to.searchParams.get("error")).toBe("invalid_request");
    expect(to.searchParams.get("state")).toBe("st-1");
  });

  it("checks the key against Populi, then redirects back with a code and the state", async () => {
    const { handler, populi } = setup();
    const res = await handler(submit(await register(handler)));
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get("location")!);
    expect(to.origin + to.pathname).toBe(REDIRECT);
    expect(to.searchParams.get("state")).toBe("st-1");
    expect(to.searchParams.get("code")).toMatch(/^pm1\./);
    expect(populi.calls[0]!.url.origin).toBe(INSTANCE);
    expect(populi.calls[0]!.url.pathname).toBe("/api2/people");
    expect(populi.calls[0]!.headers.Authorization).toBe(`Bearer ${KEY}`);
  });

  it("shows Populi's rejection on the page without echoing the key", async () => {
    const { handler } = setup({}, jsonResponse({ error: { code: "UNAUTHORIZED", message: "bad key" } }, { status: 401 }));
    const res = await handler(submit(await register(handler)));
    const html = await res.text();
    expect(res.status).toBe(400);
    expect(html).toContain("rejected that API key");
    expect(html).not.toContain(KEY);
  });

  it("accepts a key whose role can't list people (403)", async () => {
    const { handler } = setup({}, jsonResponse({ error: { code: "FORBIDDEN", message: "no" } }, { status: 403 }));
    expect((await handler(submit(await register(handler)))).status).toBe(302);
  });

  it("refuses addresses outside the allowed Populi hosts, so the server can't be pointed at arbitrary sites", async () => {
    const { handler, populi } = setup();
    for (const base_url of ["https://evil.example", "https://populiweb.com.evil.example", "http://localhost:9"]) {
      const res = await handler(submit(await register(handler), { base_url }));
      expect(res.status, base_url).toBe(400);
    }
    expect(populi.calls).toHaveLength(0);
  });

  it("ignores a typed address when the instance is pinned", async () => {
    const { handler, populi } = setup({ baseUrl: `${INSTANCE}/api2` });
    await handler(submit(await register(handler), { base_url: "https://evil.example" }));
    expect(populi.calls[0]!.url.origin).toBe(INSTANCE);
  });

  it("rejects a form posted from another site", async () => {
    const { handler } = setup();
    const clientId = await register(handler);
    const req = submit(clientId);
    req.headers.set("origin", "https://evil.example");
    expect((await handler(req)).status).toBe(403);
  });
});

describe("token endpoint", () => {
  it("trades a code for tokens with PKCE", async () => {
    const { handler } = setup();
    const { tokens } = await signIn(handler);
    expect(tokens.access_token).toMatch(/^pm1\./);
    expect(tokens.refresh_token).toMatch(/^pm1\./);
    expect(tokens.expires_in).toBe(3600);
  });

  it("fails on a wrong verifier, client, redirect or garbage code", async () => {
    const { handler } = setup();
    const clientId = await register(handler);
    const code = new URL((await handler(submit(clientId))).headers.get("location")!).searchParams.get("code")!;

    for (const over of [{ code_verifier: "w".repeat(60) }, { redirect_uri: "https://claude.ai/other" }, { client_id: "pm1.other" }, { code: "pm1.zzz" }]) {
      const res = await exchange(handler, clientId, code, over);
      expect(res.status, JSON.stringify(over)).toBe(400);
      expect(((await res.json()) as any).error).toBe("invalid_grant");
    }
    expect((await exchange(handler, clientId, code)).status).toBe(200);
  });

  it("refreshes, and a refresh token is useless as an access token", async () => {
    const { handler } = setup();
    const { clientId, tokens } = await signIn(handler);
    const res = await handler(
      post("/token", new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId }).toString()),
    );
    expect(res.status).toBe(200);
    const again = (await res.json()) as { access_token: string };
    expect((await rpc(handler, again.access_token, "tools/list")).res.status).toBe(200);
    expect((await rpc(handler, tokens.refresh_token, "tools/list")).res.status).toBe(401);
  });

  it("rejects unsupported grants", async () => {
    const { handler } = setup();
    const res = await handler(post("/token", "grant_type=password&username=a&password=b"));
    expect(((await res.json()) as any).error).toBe("unsupported_grant_type");
  });
});

describe("MCP endpoint", () => {
  it("answers 401 with a pointer to the metadata when there is no valid token", async () => {
    const { handler } = setup();
    for (const token of [undefined, "pm1.garbage"]) {
      const { res } = await rpc(handler, token, "tools/list");
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain(`resource_metadata="${BASE}/.well-known/oauth-protected-resource"`);
    }
  });

  it("serves initialize and tools/list over plain JSON", async () => {
    const { handler } = setup();
    const { tokens } = await signIn(handler);
    const init = await rpc(handler, tokens.access_token, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "t", version: "0" },
    });
    expect(init.body.result.serverInfo.name).toBe("populi-mcp");

    const list = await rpc(handler, tokens.access_token, "tools/list");
    const names = list.body.result.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual(["populi_describe_api", "populi_download", "populi_find_people", "populi_get", "populi_search_api", "populi_status"]);
  });

  it("calls Populi with the caller's own instance and key", async () => {
    const { handler, populi } = setup();
    const { tokens } = await signIn(handler);
    populi.calls.length = 0;
    const { body } = await rpc(handler, tokens.access_token, "tools/call", { name: "populi_get", arguments: { path: "/people", limit: 1 } });
    expect(body.result.content[0].text).toContain("Ada");
    expect(populi.calls).toHaveLength(1);
    expect(populi.calls[0]!.url.origin).toBe(INSTANCE);
    expect(populi.calls[0]!.headers.Authorization).toBe(`Bearer ${KEY}`);
  });

  it("keeps people apart: each token reaches only its own key", async () => {
    const { handler, populi } = setup();
    const a = await signIn(handler, { api_key: "sk_live_AAAA" });
    const b = await signIn(handler, { api_key: "sk_live_BBBB" });
    populi.calls.length = 0;
    await rpc(handler, a.tokens.access_token, "tools/call", { name: "populi_get", arguments: { path: "/people" } });
    await rpc(handler, b.tokens.access_token, "tools/call", { name: "populi_get", arguments: { path: "/people" } });
    expect(populi.calls.map((c) => c.headers.Authorization)).toEqual(["Bearer sk_live_AAAA", "Bearer sk_live_BBBB"]);
  });

  it("is read-only unless the deployment allows writes and the person opted in", async () => {
    for (const [allow, optIn, expected] of [
      [false, true, false],
      [true, false, false],
      [true, true, true],
    ] as const) {
      const { handler } = setup({ allowWrites: allow });
      const { tokens } = await signIn(handler, optIn ? { allow_writes: "on" } : {});
      const names = (await rpc(handler, tokens.access_token, "tools/list")).body.result.tools.map((t: { name: string }) => t.name);
      expect(names.includes("populi_write"), `allow=${allow} optIn=${optIn}`).toBe(expected);
    }
  });

  it("has no local files folder: uploads need base64 and a binary download comes back attached", async () => {
    const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
    const { handler, populi } = setup(
      { allowWrites: true },
      people(),
      new Response(png, { headers: { "content-type": "application/pdf", "content-disposition": 'attachment; filename="t.pdf"' } }),
    );
    const { tokens } = await signIn(handler, { allow_writes: "on" });

    const down = await rpc(handler, tokens.access_token, "tools/call", { name: "populi_download", arguments: { path: "/files/9/download" } });
    const [text, resource] = down.body.result.content;
    expect(text.text).toContain("t.pdf");
    expect(resource.type).toBe("resource");
    expect(resource.resource.mimeType).toBe("application/pdf");
    expect(Array.from(Buffer.from(resource.resource.blob, "base64"))).toEqual(Array.from(png));
    expect(populi.calls.at(-1)!.url.pathname).toBe("/api2/files/9/download");

    const up = await rpc(handler, tokens.access_token, "tools/call", {
      name: "populi_write",
      arguments: { method: "POST", path: "/people/1/upload_file", files: [{ path: "/etc/passwd" }] },
    });
    expect(up.body.result.isError).toBe(true);
    expect(up.body.result.content[0].text).toContain("content_base64");
  });

  it("refuses GET and DELETE: there are no sessions", async () => {
    const { handler } = setup();
    const res = await handler(new Request(`${BASE}/mcp`, { method: "GET" }));
    expect(res.status).toBe(405);
  });

  it("stops honouring tokens for a different instance when the deployment is pinned", async () => {
    const open = setup({}, people());
    const { tokens } = await signIn(open.handler);
    // same secret, but this deployment is now pinned to another school
    const pinned = createHostedHandler({
      config: hostedConfig({ baseUrl: "https://other.populiweb.com/api2" }),
      version: "0.0.0-test",
      fetch: open.populi.fetch,
    });
    expect((await rpc(pinned, tokens.access_token, "tools/list")).res.status).toBe(401);
  });

  it("never logs tokens, keys or bodies", async () => {
    const lines: string[] = [];
    const populi = fakeFetch(people());
    const handler = createHostedHandler({ config: hostedConfig(), version: "0.0.0-test", fetch: populi.fetch, log: (l) => lines.push(l) });
    const { tokens } = await signIn(handler);
    await rpc(handler, tokens.access_token, "tools/call", { name: "populi_get", arguments: { path: "/people" } });
    const logged = lines.join("\n");
    expect(logged).toContain("POST /mcp 200");
    expect(logged).not.toContain(KEY);
    expect(logged).not.toContain(tokens.access_token);
    expect(logged).not.toContain("pm1.");
  });
});

describe("over a real HTTP socket", () => {
  it("serves discovery and the connect page, taking the public scheme from x-forwarded-proto", async () => {
    const { handler } = setup({ publicUrl: undefined });
    const server = await listen(handler, 0, "127.0.0.1");
    try {
      const { port } = server.address() as { port: number };
      const meta = (await (
        await fetch(`http://127.0.0.1:${port}/.well-known/oauth-authorization-server`, {
          headers: { "x-forwarded-proto": "https", "x-forwarded-host": "mcp.example.edu" },
        })
      ).json()) as any;
      expect(meta.issuer).toBe("https://mcp.example.edu");

      const noToken = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-proto": "https", "x-forwarded-host": "mcp.example.edu" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(noToken.status).toBe(401);
      expect(noToken.headers.get("www-authenticate")).toContain("https://mcp.example.edu/.well-known/oauth-protected-resource");

      const tooBig = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", body: "x".repeat(6 * 1024 * 1024) });
      expect(tooBig.status).toBe(413);
    } finally {
      server.close();
    }
  });
});

const MODERN = "2026-07-28";

interface Sent {
  httpMethod: string;
  rpc?: string;
  version: string | null;
  status: number;
}

/** A real v2 SDK client talking HTTP to the handler, with every exchange recorded. */
async function sdkClient(handler: Handler, accessToken: string, mode: "legacy" | "auto" | { pin: string }) {
  const sent: Sent[] = [];
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    fetch: async (url, init) => {
      const req = new Request(url, init);
      const body =
        req.method === "POST" ? ((await req.clone().json().catch(() => undefined)) as { method?: string } | undefined) : undefined;
      const res = await handler(req);
      sent.push({ httpMethod: req.method, rpc: body?.method, version: req.headers.get("mcp-protocol-version"), status: res.status });
      return res;
    },
    requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
  });
  const client = new Client({ name: "test", version: "0" }, { versionNegotiation: { mode } });
  await client.connect(transport);
  return { client, sent };
}

const toolNames = async (client: Client) => (await client.listTools()).tools.map((t) => t.name).sort();

describe("MCP endpoint, 2026-07-28 clients", () => {
  it("serves a client pinned to 2026-07-28: server/discover, then plain requests, no initialize and no 400", async () => {
    const { handler, populi } = setup();
    const { tokens } = await signIn(handler);
    const { client, sent } = await sdkClient(handler, tokens.access_token, { pin: MODERN });
    expect(client.getNegotiatedProtocolVersion()).toBe(MODERN);
    expect(client.getProtocolEra()).toBe("modern");
    expect(client.getServerVersion()?.name).toBe("populi-mcp");
    expect(client.getInstructions()).toContain("Populi is a student information system");

    expect(await toolNames(client)).toEqual([
      "populi_describe_api",
      "populi_download",
      "populi_find_people",
      "populi_get",
      "populi_search_api",
      "populi_status",
    ]);

    populi.calls.length = 0;
    const res = await client.callTool({ name: "populi_get", arguments: { path: "/people", limit: 1 } });
    expect((res.content as { text: string }[])[0]!.text).toContain("Ada");
    expect(populi.calls[0]!.headers.Authorization).toBe(`Bearer ${KEY}`);

    expect(sent[0]!.rpc).toBe("server/discover");
    expect(sent.map((s) => s.rpc)).not.toContain("initialize");
    for (const s of sent) {
      expect(s.status, `${s.rpc}`).toBe(200);
      expect(s.version, `${s.rpc}`).toBe(MODERN);
    }
  });

  it("lets an auto-negotiating client settle on 2026-07-28 without the rejected first request", async () => {
    const { handler } = setup();
    const { tokens } = await signIn(handler);
    const { client, sent } = await sdkClient(handler, tokens.access_token, "auto");
    expect(client.getNegotiatedProtocolVersion()).toBe(MODERN);
    await client.listTools();
    expect(sent.filter((s) => s.status >= 400)).toEqual([]);
    expect(sent.map((s) => s.rpc)).not.toContain("initialize");
  });

  it("still gives 2025-era clients the classic handshake", async () => {
    const { handler } = setup();
    const { tokens } = await signIn(handler);
    const { client, sent } = await sdkClient(handler, tokens.access_token, "legacy");
    expect(client.getNegotiatedProtocolVersion()).toBe("2025-11-25");
    expect(client.getProtocolEra()).toBe("legacy");
    expect(await toolNames(client)).toContain("populi_get");
    expect(sent[0]!.rpc).toBe("initialize");
    // every POST succeeds; the optional GET for a server-to-client stream gets 405, as a stateless server should answer
    expect(sent.filter((s) => s.httpMethod === "POST").every((s) => s.status < 400)).toBe(true);
    expect(sent.filter((s) => s.httpMethod === "GET").map((s) => s.status)).toEqual([405]);
  });

  it("shows both eras the same tools, schemas and annotations", async () => {
    const { handler } = setup({ allowWrites: true });
    const { tokens } = await signIn(handler, { allow_writes: "on" });
    const modern = (await (await sdkClient(handler, tokens.access_token, { pin: MODERN })).client.listTools()).tools;
    const legacy = (await (await sdkClient(handler, tokens.access_token, "legacy")).client.listTools()).tools;
    const shape = (tools: typeof modern) =>
      tools.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations }));
    expect(modern.map((t) => t.name)).toContain("populi_write");
    expect(shape(modern)).toEqual(shape(legacy));
  });

  it("answers a raw server/discover carrying the 2026-07-28 envelope with 200", async () => {
    const { handler } = setup();
    const { tokens } = await signIn(handler);
    const res = await handler(
      post(
        "/mcp",
        {
          jsonrpc: "2.0",
          id: 1,
          method: "server/discover",
          params: {
            _meta: {
              "io.modelcontextprotocol/protocolVersion": MODERN,
              "io.modelcontextprotocol/clientInfo": { name: "raw", version: "0" },
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        },
        {
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${tokens.access_token}`,
          "mcp-protocol-version": MODERN,
          "mcp-method": "server/discover",
        },
      ),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as any;
    expect(body.result.supportedVersions).toContain(MODERN);
    expect(body.result.capabilities.tools.listChanged).toBe(false);
  });

  it("still requires a token on 2026-07-28 requests", async () => {
    const { handler } = setup();
    const res = await handler(
      post("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, { "mcp-protocol-version": MODERN, "mcp-method": "tools/list" }),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("resource_metadata=");
  });

  it("turns down subscriptions/listen at once instead of holding a stream open", async () => {
    const { handler } = setup();
    const { tokens } = await signIn(handler);
    const res = await handler(
      post(
        "/mcp",
        { jsonrpc: "2.0", id: 9, method: "subscriptions/listen", params: {} },
        { authorization: `Bearer ${tokens.access_token}`, "mcp-protocol-version": MODERN, "mcp-method": "subscriptions/listen" },
      ),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).error.code).toBe(-32601);
  });

  it("keeps writes opt-in on 2026-07-28 too", async () => {
    const { handler } = setup({ allowWrites: true });
    const reader = await signIn(handler);
    const writer = await signIn(handler, { allow_writes: "on" });
    expect(await toolNames((await sdkClient(handler, reader.tokens.access_token, { pin: MODERN })).client)).not.toContain(
      "populi_write",
    );
    expect(await toolNames((await sdkClient(handler, writer.tokens.access_token, { pin: MODERN })).client)).toContain("populi_write");
  });

  it("logs 2026-07-28 traffic the same way: method, path, status, timing only", async () => {
    const lines: string[] = [];
    const populi = fakeFetch(people());
    const handler = createHostedHandler({ config: hostedConfig(), version: "0.0.0-test", fetch: populi.fetch, log: (l) => lines.push(l) });
    const { tokens } = await signIn(handler);
    lines.length = 0;
    const { client } = await sdkClient(handler, tokens.access_token, { pin: MODERN });
    await client.callTool({ name: "populi_get", arguments: { path: "/people" } });
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).toMatch(/^POST \/mcp 200 \d+ms$/);
  });
});
