import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { PopuliClient } from "../src/lib/client.js";
import { createServer } from "../src/server.js";
import { fakeFetch, jsonResponse, TEST_CONFIG, type Reply } from "./helpers.js";

async function connect(opts: { allowWrites?: boolean }, ...replies: Reply[]) {
  const config = { ...TEST_CONFIG, allowWrites: opts.allowWrites ?? false };
  const http = fakeFetch(...replies);
  const server = createServer(config, "0.0.0-test", { client: new PopuliClient(config, http.fetch) });
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as { text: string }[])[0]!.text;
    return { text, isError: !!res.isError };
  };
  return { client, call, http };
}

describe("tool registration", () => {
  it("is read-only by default: no write tool is exposed", async () => {
    const { client } = await connect({});
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["populi_describe_api", "populi_find_people", "populi_get", "populi_search_api", "populi_status"]);
  });

  it("exposes populi_write only when writes are allowed, marked destructive", async () => {
    const { client } = await connect({ allowWrites: true });
    const tools = (await client.listTools()).tools;
    const write = tools.find((t) => t.name === "populi_write");
    expect(write?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    for (const t of tools.filter((t) => t.name !== "populi_write")) {
      expect(t.annotations?.readOnlyHint).toBe(true);
    }
  });

  it("tells the model whether it is read-only", async () => {
    const ro = await connect({});
    expect(ro.client.getInstructions()).toMatch(/read-only/);
    const rw = await connect({ allowWrites: true });
    expect(rw.client.getInstructions()).toMatch(/Writes are enabled/);
  });
});

describe("catalog tools", () => {
  it("searches and describes without any HTTP traffic", async () => {
    const { call, http } = await connect({}, jsonResponse({}));
    const search = await call("populi_search_api", { query: "email addresses" });
    expect(search.text).toMatch(/emailaddresses/);
    const detail = await call("populi_describe_api", { method: "POST", path: "/people" });
    expect(detail.text).toContain("first_name (required)");
    expect((await call("populi_describe_api", { id: "nope.nope" })).isError).toBe(true);
    expect(http.calls).toHaveLength(0);
  });
});

describe("populi_get", () => {
  it("passes filter, expand, limit and page through as request parameters", async () => {
    const { call, http } = await connect({}, jsonResponse({ object: "list", data: [{ id: 1 }] }));
    const res = await call("populi_get", { path: "/people", expand: ["tags"], limit: 10, page: 2, filter: { a: 1 } });
    expect(res.isError).toBe(false);
    expect(JSON.parse(http.calls[0]!.url.searchParams.get("parameters")!)).toEqual({
      expand: ["tags"],
      limit: 10,
      page: 2,
      filter: { a: 1 },
    });
  });

  it("follows pagination with all_pages and honours the record cap", async () => {
    const page = (n: number, pages: number, count: number) =>
      jsonResponse({ object: "list", pages, data: Array.from({ length: count }, (_, i) => ({ id: n * 1000 + i })) });
    const { call, http } = await connect({}, page(1, 3, 200), page(2, 3, 200), page(3, 3, 50));

    const all = await call("populi_get", { path: "/people", all_pages: true, max_records: 5000 });
    const parsed = JSON.parse(all.text);
    expect(parsed).toMatchObject({ results: 450, complete: true, pages_fetched: 3 });
    expect(http.calls.map((c) => JSON.parse(c.url.searchParams.get("parameters")!).page)).toEqual([1, 2, 3]);

    const capped = await connect({}, page(1, 3, 200), page(2, 3, 200), page(3, 3, 50));
    const out = JSON.parse((await capped.call("populi_get", { path: "/people", all_pages: true, max_records: 250 })).text);
    expect(out).toMatchObject({ results: 250, complete: false });
  });

  it("returns non-list responses untouched under all_pages", async () => {
    const { call } = await connect({}, jsonResponse({ object: "person", id: 7 }));
    expect(JSON.parse((await call("populi_get", { path: "/people/7", all_pages: true })).text)).toEqual({
      object: "person",
      id: 7,
    });
  });

  it("truncates oversized output with guidance", async () => {
    const big = jsonResponse({ data: Array.from({ length: 2000 }, (_, i) => ({ i, pad: "x".repeat(50) })) });
    const { call } = await connect({}, big);
    const res = await call("populi_get", { path: "/people", max_chars: 1000 });
    expect(res.text).toMatch(/truncated/);
    expect(res.text.length).toBeLessThan(1500);
  });

  it("surfaces API errors as tool errors", async () => {
    const { call } = await connect({}, jsonResponse({ code: "not_found", message: "No such person" }, { status: 404 }));
    const res = await call("populi_get", { path: "/people/999" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/No such person/);
  });

  it("refuses absolute URLs so the key cannot be sent elsewhere", async () => {
    const { call, http } = await connect({}, jsonResponse({}));
    const res = await call("populi_get", { path: "https://evil.example/people" });
    expect(res.isError).toBe(true);
    expect(http.calls).toHaveLength(0);
  });
});

describe("populi_find_people", () => {
  it("uses the `email` filter name and CONTAINS for names", async () => {
    const { call, http } = await connect({}, jsonResponse({ data: [] }));
    await call("populi_find_people", { email: " a@b.org ", first_name: "ann" });
    const params = JSON.parse(http.calls[0]!.url.searchParams.get("parameters")!);
    expect(params.filter["0"]).toEqual({
      logic: "ALL",
      fields: [
        { name: "email", value: "a@b.org", positive: "1" },
        { name: "first_name", value: { type: "CONTAINS", text: "ann" }, positive: 1 },
      ],
    });
  });

  it("refuses an empty search, which Populi would answer with everyone", async () => {
    const { call, http } = await connect({}, jsonResponse({}));
    expect((await call("populi_find_people", { email: "  " })).isError).toBe(true);
    expect(http.calls).toHaveLength(0);
  });
});

describe("populi_write", () => {
  it("sends the body with the chosen method", async () => {
    const { call, http } = await connect({ allowWrites: true }, jsonResponse({ object: "person", id: 5 }));
    const res = await call("populi_write", { method: "POST", path: "/people", body: { first_name: "A", last_name: "B" } });
    expect(res.isError).toBe(false);
    expect(res.text).not.toMatch(/does not match/);
    expect(http.calls[0]).toMatchObject({ method: "POST", body: { first_name: "A", last_name: "B" } });
  });

  it("flags routes missing from the catalog", async () => {
    const { call } = await connect({ allowWrites: true }, jsonResponse({ ok: true }));
    expect((await call("populi_write", { method: "DELETE", path: "/made/up/1" })).text).toMatch(/does not match a documented route/);
  });
});

describe("populi_status", () => {
  it("reports configuration offline and never prints the key", async () => {
    const { call, http } = await connect({});
    const res = await call("populi_status");
    expect(res.text).toContain("sandbox");
    expect(res.text).toMatch(/Writes: disabled/);
    expect(res.text).not.toContain("sk_sandbox_test");
    expect(http.calls).toHaveLength(0);
  });

  it("verify distinguishes a bad key from a role limit", async () => {
    const denied = await connect({}, jsonResponse({ message: "no" }, { status: 403 }));
    const r403 = await denied.call("populi_status", { verify: true });
    expect(r403).toMatchObject({ isError: false });
    expect(r403.text).toMatch(/role cannot list people/);

    const bad = await connect({}, jsonResponse({ message: "bad key" }, { status: 401 }));
    expect((await bad.call("populi_status", { verify: true })).isError).toBe(true);
  });
});
