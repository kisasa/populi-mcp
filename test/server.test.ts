import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { PopuliClient } from "../src/lib/client.js";
import { createServer } from "../src/server.js";
import { fakeFetch, jsonResponse, testConfig, type Reply } from "./helpers.js";

async function connect(opts: { allowWrites?: boolean; filesDir?: string }, ...replies: Reply[]) {
  const config = testConfig({ allowWrites: opts.allowWrites ?? false, ...(opts.filesDir ? { filesDir: opts.filesDir } : {}) });
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
  return { client, call, http, filesDir: config.filesDir };
}

const page = (n: number, pages: number, count: number) =>
  jsonResponse({ object: "list", pages, data: Array.from({ length: count }, (_, i) => ({ id: n * 1000 + i })) });

describe("tool registration", () => {
  it("is read-only by default: no write tool is exposed", async () => {
    const { client } = await connect({});
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "populi_describe_api",
      "populi_download",
      "populi_find_people",
      "populi_get",
      "populi_search_api",
      "populi_status",
    ]);
  });

  it("exposes populi_write only when writes are allowed, marked destructive", async () => {
    const { client } = await connect({ allowWrites: true });
    const tools = (await client.listTools()).tools;
    const write = tools.find((t) => t.name === "populi_write");
    expect(write?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });

  it("is honest about what each tool changes", async () => {
    const { client } = await connect({ allowWrites: true });
    const by = Object.fromEntries((await client.listTools()).tools.map((t) => [t.name, t.annotations]));
    for (const name of ["populi_get", "populi_find_people", "populi_search_api", "populi_describe_api", "populi_status"]) {
      expect(by[name]?.readOnlyHint, name).toBe(true);
    }
    // it writes local files, so it must not claim to be read-only, but it only ever adds new ones
    expect(by.populi_download).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  });

  it("tells the model the people list carries primary email and phone", async () => {
    const { client } = await connect({});
    const tool = (await client.listTools()).tools.find((t) => t.name === "populi_find_people");
    expect(tool?.description).toContain("contact_primary_email");
    expect(tool?.description).not.toMatch(/has no email/);
  });

  it("tells the model whether it is read-only", async () => {
    const ro = await connect({});
    expect(ro.client.getInstructions()).toMatch(/read-only/);
    expect(ro.client.getInstructions()).toMatch(/populi_download/);
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

  it("points upload and download routes at the right tool", async () => {
    const { call } = await connect({});
    expect((await call("populi_describe_api", { id: "people.upload_file" })).text).toMatch(/File upload: call populi_write with `files`/);
    expect((await call("populi_describe_api", { id: "files.download" })).text).toMatch(/Use populi_download/);
    expect((await call("populi_describe_api", { id: "applications.export_pdf" })).text).toMatch(/Use populi_download/);
    expect((await call("populi_describe_api", { id: "people.show" })).text).not.toMatch(/populi_download|File upload/);
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

  it("follows pagination with all_pages", async () => {
    const { call, http } = await connect({}, page(1, 3, 200), page(2, 3, 200), page(3, 3, 50));
    const parsed = JSON.parse((await call("populi_get", { path: "/people", all_pages: true, max_records: 5000 })).text);
    expect(parsed).toMatchObject({ results: 450, complete: true, pages_fetched: 3 });
    expect(parsed.next_page).toBeUndefined();
    expect(http.calls.map((c) => JSON.parse(c.url.searchParams.get("parameters")!).page)).toEqual([1, 2, 3]);
  });

  it("treats max_records as a stopping point and says where to resume, never dropping records", async () => {
    const { call } = await connect({}, page(1, 3, 200), page(2, 3, 200), page(3, 3, 50));
    const out = JSON.parse((await call("populi_get", { path: "/people", all_pages: true, max_records: 250 })).text);
    expect(out).toMatchObject({ results: 400, complete: false, pages_fetched: 2, next_page: 3 });
    expect(out.data).toHaveLength(400);
  });

  it("starts all_pages from the requested page", async () => {
    const { call, http } = await connect({}, page(3, 3, 50));
    const out = JSON.parse((await call("populi_get", { path: "/people", all_pages: true, page: 3 })).text);
    expect(out).toMatchObject({ results: 50, complete: true });
    expect(JSON.parse(http.calls[0]!.url.searchParams.get("parameters")!).page).toBe(3);
  });

  it("keeps the pages it already has when a later page is rate limited, and says where to resume", async () => {
    const limited = new Response("slow down", { status: 429, headers: { "retry-after": "40" } });
    const { call } = await connect({}, page(1, 5, 200), page(2, 5, 200), limited);
    const res = await call("populi_get", { path: "/people", all_pages: true, max_records: 5000 });
    expect(res.isError).toBe(false);
    const out = JSON.parse(res.text);
    expect(out).toMatchObject({ results: 400, complete: false, pages_fetched: 2, next_page: 3 });
    expect(out.error).toMatch(/rate limit/i);
  });

  it("still fails outright when the very first page fails", async () => {
    const { call } = await connect({}, jsonResponse({ message: "no" }, { status: 403 }));
    const res = await call("populi_get", { path: "/people", all_pages: true });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/403/);
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
    expect(res.text).toMatch(/populi_download/);
    expect(res.text.length).toBeLessThan(1500);
  });

  it("describes a file response and sends the model to populi_download, without writing anything", async () => {
    const pdf = new Response(new Uint8Array(12), {
      headers: { "content-type": "application/pdf", "content-disposition": 'attachment; filename="t.pdf"' },
    });
    const { call, filesDir } = await connect({}, pdf);
    const res = await call("populi_get", { path: "/people/5/export_transcript" });
    expect(res.isError).toBe(false);
    expect(res.text).toMatch(/t\.pdf.*12 bytes/);
    expect(res.text).toMatch(/populi_download/);
    expect(readdirSync(filesDir)).toEqual([]);
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

describe("populi_download", () => {
  it("saves a binary export into the files folder under the name Populi suggests", async () => {
    const pdf = new Response(new Uint8Array([37, 80, 68, 70]), {
      headers: { "content-type": "application/pdf", "content-disposition": 'attachment; filename="transcript.pdf"' },
    });
    const { call, filesDir } = await connect({}, pdf);
    const res = await call("populi_download", { path: "/people/5/export_transcript" });
    expect(res.isError).toBe(false);
    expect(res.text).toContain(join(filesDir, "transcript.pdf"));
    expect(Array.from(readFileSync(join(filesDir, "transcript.pdf")))).toEqual([37, 80, 68, 70]);
  });

  it("honours save_as, keeps it inside the folder, and never overwrites", async () => {
    const mk = () => new Response(new Uint8Array([1]), { headers: { "content-type": "application/pdf" } });
    const { call, filesDir } = await connect({}, mk());
    await call("populi_download", { path: "/x", save_as: "../../grades.pdf" });
    await call("populi_download", { path: "/x", save_as: "grades.pdf" });
    expect(readdirSync(filesDir).sort()).toEqual(["grades-1.pdf", "grades.pdf"]);
  });

  it("saves CSV and shows a preview", async () => {
    const csv = new Response("name,gpa\nAda,4.0\n", { headers: { "content-type": "text/csv" } });
    const { call, filesDir } = await connect({}, csv);
    const res = await call("populi_download", { path: "/dataslicerreports/3/results", params: { format: "csv" }, save_as: "report.csv" });
    expect(readFileSync(join(filesDir, "report.csv"), "utf8")).toBe("name,gpa\nAda,4.0\n");
    expect(res.text).toContain("Ada,4.0");
  });

  it("saves a whole paginated list as JSON without putting it in the conversation", async () => {
    const { call, filesDir, http } = await connect({}, page(1, 2, 200), page(2, 2, 30));
    const res = await call("populi_download", { path: "/people", all_pages: true, save_as: "everyone" });
    expect(res.isError).toBe(false);
    const saved = JSON.parse(readFileSync(join(filesDir, "everyone.json"), "utf8"));
    expect(saved).toMatchObject({ results: 230, complete: true });
    expect(saved.data).toHaveLength(230);
    expect(res.text.length).toBeLessThan(2500); // a preview, not the 230 records
    expect(http.calls).toHaveLength(2);
  });

  it("passes the timeout through for slow reports", async () => {
    let signal: AbortSignal | null | undefined;
    const config = testConfig();
    const spy = (async (_u: string, init?: RequestInit) => {
      signal = init?.signal;
      return new Response(new Uint8Array([1]), { headers: { "content-type": "application/vnd.ms-excel" } });
    }) as unknown as typeof fetch;
    const server = createServer(config, "0", { client: new PopuliClient(config, spy) });
    const client = new Client({ name: "t", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    await client.callTool({ name: "populi_download", arguments: { path: "/dataslicerreports/1/results", timeout_ms: 300000 } });
    expect(signal).toBeDefined();
  });

  it("reports errors and writes nothing", async () => {
    const { call, filesDir } = await connect({}, jsonResponse({ message: "No such file" }, { status: 404 }));
    const res = await call("populi_download", { path: "/files/9/download" });
    expect(res.isError).toBe(true);
    expect(readdirSync(filesDir)).toEqual([]);
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

  it("uploads a file from the files folder as multipart, with the other fields as `parameters`", async () => {
    const { call, http, filesDir } = await connect({ allowWrites: true }, jsonResponse({ object: "file", id: 3 }));
    writeFileSync(join(filesDir, "photo.jpg"), Buffer.from([1, 2, 3]));
    const res = await call("populi_write", {
      method: "POST",
      path: "/people/5/upload_file",
      body: { visibility_role_ids: [7, 10], academic_term_id: 470 },
      files: [{ path: "photo.jpg" }],
    });
    expect(res.isError).toBe(false);
    expect(res.text).not.toMatch(/does not match/);
    const form = http.calls[0]!.form!;
    const part = form.get("file") as File;
    expect(part.name).toBe("photo.jpg");
    expect(part.type).toBe("image/jpeg");
    expect(Array.from(new Uint8Array(await part.arrayBuffer()))).toEqual([1, 2, 3]);
    expect(JSON.parse(form.get("parameters") as string)).toEqual({ visibility_role_ids: [7, 10], academic_term_id: 470 });
  });

  it("uploads base64 content", async () => {
    const { call, http } = await connect({ allowWrites: true }, jsonResponse({ id: 1 }));
    await call("populi_write", {
      method: "POST",
      path: "/people/5/update_profile_picture",
      files: [{ content_base64: Buffer.from("png-bytes").toString("base64"), filename: "me.png" }],
    });
    const part = http.calls[0]!.form!.get("file") as File;
    expect(part.name).toBe("me.png");
    expect(part.type).toBe("image/png");
    expect(await part.text()).toBe("png-bytes");
    expect(http.calls[0]!.form!.has("parameters")).toBe(false);
  });

  it("will not upload a file from outside the files folder, and sends nothing", async () => {
    const { call, http } = await connect({ allowWrites: true }, jsonResponse({}));
    for (const path of ["../secret.txt", "/etc/passwd", "C:\\Windows\\win.ini"]) {
      const res = await call("populi_write", { method: "POST", path: "/people/5/upload_file", files: [{ path }] });
      expect(res.isError, path).toBe(true);
    }
    expect(http.calls).toHaveLength(0);
  });

  it("refuses an upload on DELETE", async () => {
    const { call, http } = await connect({ allowWrites: true }, jsonResponse({}));
    const res = await call("populi_write", { method: "DELETE", path: "/people/5", files: [{ content_base64: "AA==" }] });
    expect(res.isError).toBe(true);
    expect(http.calls).toHaveLength(0);
  });
});

describe("populi_status", () => {
  it("reports configuration offline and never prints the key", async () => {
    const { call, http, filesDir } = await connect({});
    const res = await call("populi_status");
    expect(res.text).toContain("sandbox");
    expect(res.text).toMatch(/Writes: disabled/);
    expect(res.text).toContain(filesDir);
    expect(res.text).toMatch(/Request timeout: 5s/);
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
