import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, vi } from "vitest";

export interface Call {
  url: URL;
  method: string;
  headers: Record<string, string>;
  /** Parsed JSON body, when the request sent one. */
  body?: unknown;
  /** The multipart body, when the request was an upload. */
  form?: FormData;
}

export type Reply = Response | ((call: Call) => Response | Promise<Response>);

export function jsonResponse(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

/** A fetch stand-in that records requests and replays queued responses in order. */
export function fakeFetch(...replies: Reply[]) {
  const calls: Call[] = [];
  const queue = [...replies];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: new URL(String(input)),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      form: init?.body instanceof FormData ? init.body : undefined,
    };
    calls.push(call);
    const next = queue.length > 1 ? queue.shift()! : queue[0];
    if (!next) throw new Error("fakeFetch: no reply queued");
    return typeof next === "function" ? next(call) : next.clone();
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A fresh temp folder, removed after the test. */
export function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "populi-mcp-test-"));
  dirs.push(d);
  return d;
}

export const BASE = "https://school.populiweb.com/api2";

export function testConfig(overrides: Partial<{ allowWrites: boolean; filesDir: string; timeoutMs: number }> = {}) {
  return {
    baseUrl: BASE,
    apiKey: "sk_sandbox_test",
    allowWrites: false,
    sandbox: true,
    filesDir: overrides.filesDir ?? tempDir(),
    timeoutMs: 5000,
    ...overrides,
  };
}

export const TEST_CONFIG = testConfig();
