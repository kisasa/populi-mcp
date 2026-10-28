import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanPath, describeFetchError, filenameFrom, PopuliClient, PopuliError } from "../src/lib/client.js";
import { BASE, fakeFetch, jsonResponse, TEST_CONFIG } from "./helpers.js";

describe("cleanPath", () => {
  it.each([
    ["/people/123", "people/123"],
    ["people/123/", "people/123"],
    ["/api2/people", "people"],
    ["api2/people", "people"],
  ])("%s -> %s", (input, expected) => expect(cleanPath(input)).toBe(expected));

  it.each([
    "https://evil.example/people",
    "//evil.example/people",
    "/people/../admin",
    "/people?x=1",
    "/people#frag",
    "/people/(person)",
    "/",
    "/people//1",
  ])("rejects %s", (input) => expect(() => cleanPath(input)).toThrow(PopuliError));
});

describe("PopuliClient", () => {
  it("sends GET params as the `parameters` query value with a bearer token", async () => {
    const { fetch, calls } = fakeFetch(jsonResponse({ object: "list", data: [] }));
    await new PopuliClient(TEST_CONFIG, fetch).request({
      method: "GET",
      path: "/people",
      params: { limit: 5, expand: ["tags"] },
    });
    const [call] = calls;
    expect(call!.url.origin + call!.url.pathname).toBe(`${BASE}/people`);
    expect(JSON.parse(call!.url.searchParams.get("parameters")!)).toEqual({ limit: 5, expand: ["tags"] });
    expect(call!.headers.Authorization).toBe("Bearer sk_sandbox_test");
    expect(call!.body).toBeUndefined();
  });

  it("omits `parameters` when there are none", async () => {
    const { fetch, calls } = fakeFetch(jsonResponse({}));
    await new PopuliClient(TEST_CONFIG, fetch).request({ method: "GET", path: "/people/1" });
    expect(calls[0]!.url.search).toBe("");
  });

  it("sends a JSON content type and body on POST, even when empty", async () => {
    const { fetch, calls } = fakeFetch(jsonResponse({ id: 1 }));
    await new PopuliClient(TEST_CONFIG, fetch).request({ method: "POST", path: "/people/1/delete" });
    expect(calls[0]!.headers["Content-Type"]).toBe("application/json");
    expect(calls[0]!.body).toEqual({});
  });

  it("turns Populi error objects into readable errors with the status", async () => {
    const { fetch } = fakeFetch(
      jsonResponse({ object: "error", code: "invalid_json", type: "bad_request", message: "Bad body" }, { status: 400 }),
    );
    await expect(new PopuliClient(TEST_CONFIG, fetch).request({ method: "POST", path: "/people" })).rejects.toMatchObject({
      status: 400,
      code: "invalid_json",
      message: expect.stringContaining("Bad body"),
    });
  });

  it("adds hints for 401 and 403 without leaking the key", async () => {
    const { fetch } = fakeFetch(jsonResponse({ message: "nope" }, { status: 401 }));
    const err = await new PopuliClient(TEST_CONFIG, fetch).request({ method: "GET", path: "/people" }).catch((e) => e);
    expect(err.message).toMatch(/POPULI_API_KEY/);
    expect(err.message).not.toContain("sk_sandbox_test");
  });

  it("reports 429 with a retry hint instead of blocking", async () => {
    const { fetch, calls } = fakeFetch(new Response("slow down", { status: 429, headers: { "retry-after": "42" } }));
    const err = await new PopuliClient(TEST_CONFIG, fetch).request({ method: "GET", path: "/people" }).catch((e) => e);
    expect(err).toBeInstanceOf(PopuliError);
    expect(err).toMatchObject({ status: 429, retryAfter: 42 });
    expect(calls).toHaveLength(1);
  });

  it("retries a GET after a transient 503 but never replays a write", async () => {
    const get = fakeFetch(new Response("", { status: 503 }), jsonResponse({ ok: true }));
    const res = await new PopuliClient(TEST_CONFIG, get.fetch).request({ method: "GET", path: "/people" });
    expect(res).toMatchObject({ kind: "json", data: { ok: true } });
    expect(get.calls).toHaveLength(2);

    const post = fakeFetch(new Response("", { status: 503 }), jsonResponse({ ok: true }));
    await expect(new PopuliClient(TEST_CONFIG, post.fetch).request({ method: "POST", path: "/people" })).rejects.toMatchObject({
      status: 503,
    });
    expect(post.calls).toHaveLength(1);
  });

  it("handles CSV and binary downloads", async () => {
    const csv = fakeFetch(new Response("a,b\n1,2", { headers: { "content-type": "text/csv" } }));
    expect(await new PopuliClient(TEST_CONFIG, csv.fetch).request({ method: "GET", path: "/x" })).toMatchObject({
      kind: "text",
      text: "a,b\n1,2",
    });
    const pdf = fakeFetch(
      new Response(new Uint8Array([1, 2, 3, 4]), {
        headers: { "content-type": "application/pdf", "content-disposition": 'attachment; filename="transcript.pdf"' },
      }),
    );
    const res = await new PopuliClient(TEST_CONFIG, pdf.fetch).request({ method: "GET", path: "/x" });
    expect(res).toMatchObject({ kind: "binary", contentType: "application/pdf", filename: "transcript.pdf" });
    expect(res.kind === "binary" && Array.from(res.data)).toEqual([1, 2, 3, 4]);
  });

  it("includes the underlying network cause instead of a bare 'fetch failed'", async () => {
    const dns = new TypeError("fetch failed", {
      cause: Object.assign(new Error("getaddrinfo ENOTFOUND tsri.demo.populiweb.com"), { code: "ENOTFOUND" }),
    });
    expect(describeFetchError(dns)).toBe("fetch failed (getaddrinfo ENOTFOUND tsri.demo.populiweb.com)");

    // a refused connection on a dual-stack host: AggregateError with no message of its own
    const refused = new TypeError("fetch failed", {
      cause: Object.assign(new AggregateError([new Error("connect ECONNREFUSED 10.0.0.1:443")], ""), {
        code: "ECONNREFUSED",
      }),
    });
    expect(describeFetchError(refused)).toBe("fetch failed (connect ECONNREFUSED 10.0.0.1:443)");

    expect(describeFetchError(new Error("boom"))).toBe("boom");
    expect(describeFetchError("odd")).toBe("odd");
  });

  it("puts the cause in the error a tool call sees", async () => {
    const fetch = (async () => {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND nope.example"), { code: "ENOTFOUND" }) });
    }) as unknown as typeof globalThis.fetch;
    await expect(new PopuliClient(TEST_CONFIG, fetch).request({ method: "POST", path: "/people" })).rejects.toThrow(
      /ENOTFOUND nope\.example/,
    );
  });

  it("reports unreachable hosts", async () => {
    const fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof globalThis.fetch;
    await expect(new PopuliClient(TEST_CONFIG, fetch).request({ method: "POST", path: "/people" })).rejects.toThrow(
      /Could not reach Populi/,
    );
  });
});

describe("filenameFrom", () => {
  it.each([
    ['attachment; filename="report.xls"', "report.xls"],
    ["attachment; filename=report.csv", "report.csv"],
    ["attachment; filename*=UTF-8''Grade%20Report.pdf", "Grade Report.pdf"],
    ["inline", undefined],
  ])("%s -> %s", (header, expected) => expect(filenameFrom(header)).toBe(expected));
  it("handles a missing header", () => expect(filenameFrom(null)).toBeUndefined());
});

describe("uploads", () => {
  const file = { field: "file", filename: "photo.jpg", contentType: "image/jpeg", data: new Uint8Array([9, 8, 7]) };

  it("sends multipart with the file and the other fields as a JSON `parameters` part", async () => {
    const { fetch, calls } = fakeFetch(jsonResponse({ id: 1 }));
    await new PopuliClient(TEST_CONFIG, fetch).request({
      method: "POST",
      path: "/people/5/upload_file",
      params: { visibility_role_ids: [7, 10] },
      files: [file],
    });
    const form = calls[0]!.form!;
    expect(form).toBeInstanceOf(FormData);
    const part = form.get("file") as File;
    expect(part.name).toBe("photo.jpg");
    expect(part.type).toBe("image/jpeg");
    expect(Array.from(new Uint8Array(await part.arrayBuffer()))).toEqual([9, 8, 7]);
    expect(JSON.parse(form.get("parameters") as string)).toEqual({ visibility_role_ids: [7, 10] });
    // fetch must add the boundary itself, so no content type may be set by us
    expect(calls[0]!.headers["Content-Type"]).toBeUndefined();
  });

  it("omits the parameters part when there are none", async () => {
    const { fetch, calls } = fakeFetch(jsonResponse({}));
    await new PopuliClient(TEST_CONFIG, fetch).request({ method: "POST", path: "/people/5/update_profile_picture", files: [file] });
    expect(calls[0]!.form!.has("parameters")).toBe(false);
  });

  it("refuses an upload on GET or DELETE", async () => {
    const { fetch, calls } = fakeFetch(jsonResponse({}));
    for (const method of ["GET", "DELETE"] as const) {
      await expect(new PopuliClient(TEST_CONFIG, fetch).request({ method, path: "/x", files: [file] })).rejects.toThrow(/POST or PUT/);
    }
    expect(calls).toHaveLength(0);
  });
});

describe("request control", () => {
  it("runs requests one at a time, since Populi allows a single heavy call", async () => {
    let inFlight = 0;
    let peak = 0;
    const slow = async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return jsonResponse({ ok: true });
    };
    const { fetch, calls } = fakeFetch(slow);
    const client = new PopuliClient(TEST_CONFIG, fetch);
    await Promise.all([1, 2, 3, 4].map((i) => client.request({ method: "GET", path: `/people/${i}` })));
    expect(peak).toBe(1);
    expect(calls.map((c) => c.url.pathname)).toEqual(["/api2/people/1", "/api2/people/2", "/api2/people/3", "/api2/people/4"]);
  });

  it("keeps working after a failed request", async () => {
    const { fetch } = fakeFetch(jsonResponse({ message: "nope" }, { status: 404 }), jsonResponse({ ok: true }));
    const client = new PopuliClient(TEST_CONFIG, fetch);
    const results = await Promise.allSettled([
      client.request({ method: "GET", path: "/people/1" }),
      client.request({ method: "GET", path: "/people/2" }),
    ]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "fulfilled"]);
  });

  it("fails fast after a 429 instead of sending more requests to a limited key", async () => {
    const { fetch, calls } = fakeFetch(new Response("slow down", { status: 429, headers: { "retry-after": "30" } }));
    const client = new PopuliClient(TEST_CONFIG, fetch);
    await expect(client.request({ method: "GET", path: "/people" })).rejects.toMatchObject({ status: 429 });
    const second = await client.request({ method: "GET", path: "/people" }).catch((e) => e);
    expect(second).toMatchObject({ status: 429 });
    expect(second.message).toMatch(/no request was sent/);
    expect(calls).toHaveLength(1);
  });

  it("reports a timeout with how to raise it, instead of 'could not reach'", async () => {
    const hang = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      })) as unknown as typeof fetch;
    const err = await new PopuliClient({ ...TEST_CONFIG, timeoutMs: 1000 }, hang)
      .request({ method: "GET", path: "/dataslicerreports/1/results", timeoutMs: 1000 })
      .catch((e) => e);
    expect(err.message).toMatch(/did not answer within 1s/);
    expect(err.message).toMatch(/timeout_ms/);
  });

  it("uses the per-request timeout over the configured one", async () => {
    let signal: AbortSignal | null | undefined;
    const spy = (async (_u: string, init?: RequestInit) => {
      signal = init?.signal;
      return jsonResponse({});
    }) as unknown as typeof fetch;
    await new PopuliClient({ ...TEST_CONFIG, timeoutMs: 1000 }, spy).request({ method: "GET", path: "/x", timeoutMs: 300_000 });
    expect(signal).toBeDefined();
  });
});

describe("very long GET parameters", () => {
  let server: Server;
  let seen: { method?: string; url?: string; body: string; auth?: string; type?: string }[];
  let baseUrl: string;

  beforeAll(async () => {
    seen = [];
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({ method: req.method, url: req.url, body, auth: req.headers.authorization, type: req.headers["content-type"] });
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ object: "list", data: [{ id: 1 }] }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api2`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("sends short parameters in the URL, as before", async () => {
    seen.length = 0;
    // the real fetch, against a real server, so this also proves the request line is well formed
    await new PopuliClient({ ...TEST_CONFIG, baseUrl }).request({ method: "GET", path: "/people", params: { limit: 5 } });
    expect(seen[0]!.url).toContain("parameters=");
    expect(seen[0]!.body).toBe("");
  });

  it("sends parameters that would overflow the URL as a GET JSON body", async () => {
    seen.length = 0;
    const ids = Array.from({ length: 3000 }, (_, i) => 100000 + i);
    const filter = { "0": { logic: "ALL", fields: [{ name: "id", value: ids, positive: 1 }] } };
    const res = await new PopuliClient({ ...TEST_CONFIG, baseUrl }).request({ method: "GET", path: "/people", params: { filter } });
    expect(res).toMatchObject({ kind: "json", data: { data: [{ id: 1 }] } });
    expect(seen[0]).toMatchObject({ method: "GET", url: "/api2/people", auth: "Bearer sk_sandbox_test", type: "application/json" });
    expect(JSON.parse(seen[0]!.body)).toEqual({ filter });
  });
});

describe("uploads over real HTTP", () => {
  it("produces a valid multipart body: boundary header, file part with bytes, and the parameters part", async () => {
    let captured: { type?: string; body: Buffer } | undefined;
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        captured = { type: req.headers["content-type"], body: Buffer.concat(chunks) };
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ object: "file", id: 1 }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api2`;
      const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 1, 2, 3, 250]); // not valid UTF-8, on purpose
      const res = await new PopuliClient({ ...TEST_CONFIG, baseUrl }).request({
        method: "POST",
        path: "/people/5/upload_file",
        params: { custom_info_field_id: 2, visibility_role_ids: [7, 10, 15] },
        files: [{ field: "file", filename: "photo.jpg", contentType: "image/jpeg", data: bytes }],
      });
      expect(res).toMatchObject({ kind: "json", data: { id: 1 } });

      const boundary = captured!.type!.match(/^multipart\/form-data; boundary=(.+)$/)?.[1];
      expect(boundary, "content-type must carry the multipart boundary").toBeTruthy();
      const raw = captured!.body.toString("latin1");
      expect(raw).toContain(`--${boundary}`);
      expect(raw).toContain('name="file"; filename="photo.jpg"');
      expect(raw).toContain("Content-Type: image/jpeg");
      expect(raw).toContain('name="parameters"');
      expect(raw).toContain('{"custom_info_field_id":2,"visibility_role_ids":[7,10,15]}');
      // the binary payload must arrive byte for byte, not mangled by a text encoding
      expect(captured!.body.includes(Buffer.from(bytes))).toBe(true);
      expect(raw.trimEnd().endsWith(`--${boundary}--`)).toBe(true);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
