import { vi } from "vitest";

export interface Call {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

export type Reply = Response | ((call: Call) => Response);

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
    };
    calls.push(call);
    const next = queue.length > 1 ? queue.shift()! : queue[0];
    if (!next) throw new Error("fakeFetch: no reply queued");
    return typeof next === "function" ? next(call) : next.clone();
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

export const BASE = "https://school.populiweb.com/api2";
export const TEST_CONFIG = { baseUrl: BASE, apiKey: "sk_sandbox_test", allowWrites: false, sandbox: true };
