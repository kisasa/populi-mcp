import { describe, expect, it } from "vitest";
import { cleanPath, describeFetchError, PopuliClient, PopuliError } from "../src/lib/client.js";
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
    const pdf = fakeFetch(new Response(new Uint8Array(10), { headers: { "content-type": "application/pdf" } }));
    expect(await new PopuliClient(TEST_CONFIG, pdf.fetch).request({ method: "GET", path: "/x" })).toMatchObject({
      kind: "binary",
      bytes: 10,
    });
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
