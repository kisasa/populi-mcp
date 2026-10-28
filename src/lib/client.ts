import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Config } from "./config.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

export class PopuliError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
    readonly body?: unknown,
    /** Seconds to wait before retrying, when Populi says so (HTTP 429). */
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "PopuliError";
  }
}

export interface UploadFile {
  /** Multipart field name. Populi's upload routes expect `file`. */
  field: string;
  filename: string;
  contentType: string;
  data: Uint8Array;
}

export type PopuliResponse =
  | { kind: "json"; status: number; data: unknown }
  | { kind: "text"; status: number; contentType: string; text: string; filename?: string }
  | { kind: "binary"; status: number; contentType: string; data: Uint8Array; filename?: string };

export interface RequestOptions {
  method: HttpMethod;
  /** Route under /api2, e.g. `/people/123`. Leading slash optional. */
  path: string;
  /**
   * Request parameters (filter, expand, page, limit, or a write body).
   * GET sends them as the `parameters` query value, since many HTTP stacks
   * (including fetch) cannot send a GET body. Everything else sends a JSON body.
   * With `files` they travel as the multipart `parameters` field.
   */
  params?: Record<string, unknown>;
  /** File uploads, sent as multipart/form-data. POST or PUT only. */
  files?: UploadFile[];
  /** Overrides the configured timeout for this one request. */
  timeoutMs?: number;
}

type ClientConfig = Pick<Config, "baseUrl" | "apiKey" | "timeoutMs">;

interface BodyGetInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
}

const RETRYABLE = new Set([502, 503, 504]);
/**
 * A GET whose `parameters` would push the URL past this is sent with a JSON body instead.
 * That is how Populi documents GET, and servers commonly refuse request lines beyond ~8 KB.
 */
export const MAX_GET_URL = 7000;

/**
 * Reduces a caller-supplied path to a safe route under the configured base.
 * The API key must only ever travel to POPULI_BASE_URL, so absolute URLs,
 * traversal and query strings are refused rather than sanitised.
 */
export function cleanPath(input: string): string {
  let path = input.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path) || path.startsWith("//")) {
    throw new PopuliError("Pass a route like /people/123, not a full URL.");
  }
  if (/[?#]/.test(path)) {
    throw new PopuliError("Put filters, expand and paging in `params`, not in the path.");
  }
  path = path.replace(/^\/?api2(?=\/|$)/, "").replace(/^\/+/, "").replace(/\/+$/, "");
  if (!path) throw new PopuliError("Path is empty. Use a route such as /people.");
  const segments = path.split("/");
  if (segments.some((s) => s === "." || s === ".." || s === "")) {
    throw new PopuliError(`Invalid path "${input}".`);
  }
  const unresolved = segments.find((s) => /[()]/.test(s));
  if (unresolved) {
    throw new PopuliError(
      `Path still contains a placeholder "${unresolved}". Replace it with the real id, e.g. /people/123.`,
    );
  }
  return segments.map(encodeURIComponent).join("/");
}

export class PopuliClient {
  /** Requests run one at a time: Populi allows a single heavy call (Data Slicer, exports) at once. */
  private tail: Promise<unknown> = Promise.resolve();
  /** After a 429 every later request waits it out locally instead of hammering a limited key. */
  private blockedUntil = 0;

  constructor(
    private readonly config: ClientConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly bodyGet: (url: string, init: BodyGetInit) => Promise<Response> = nodeRequest,
  ) {}

  request(opts: RequestOptions): Promise<PopuliResponse> {
    const run = this.tail.then(
      () => this.send(opts),
      () => this.send(opts),
    );
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async send({ method, path, params, files, timeoutMs }: RequestOptions): Promise<PopuliResponse> {
    this.assertNotRateLimited();
    let url = `${this.config.baseUrl}/${cleanPath(path)}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.apiKey}`,
      Accept: "application/json",
    };
    let body: string | FormData | undefined;
    let getWithBody = false;
    const hasParams = params !== undefined && Object.keys(params).length > 0;

    if (files?.length) {
      if (method === "GET" || method === "DELETE") throw new PopuliError(`File uploads need POST or PUT, not ${method}.`);
      const form = new FormData();
      for (const f of files) form.append(f.field, new Blob([f.data as BlobPart], { type: f.contentType }), f.filename);
      // Populi reads the non-file parameters from a `parameters` field holding JSON
      if (hasParams) form.append("parameters", JSON.stringify(params));
      body = form; // no Content-Type: fetch adds the multipart boundary itself
    } else if (method === "GET") {
      if (hasParams) {
        const query = new URLSearchParams({ parameters: JSON.stringify(params) }).toString();
        if (url.length + query.length + 1 > MAX_GET_URL) {
          getWithBody = true;
          headers["Content-Type"] = "application/json";
          body = JSON.stringify(params);
        } else {
          url += `?${query}`;
        }
      }
    } else {
      // Populi answers 400 invalid_json to a POST without this, even for an empty body.
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(params ?? {});
    }

    const timeout = timeoutMs ?? this.config.timeoutMs;
    const attempts = method === "GET" ? 3 : 1; // never replay a write
    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = getWithBody
          ? await this.bodyGet(url, { method, headers, body: body as string, timeoutMs: timeout })
          : await this.fetchImpl(url, { method, headers, body, signal: AbortSignal.timeout(timeout) });
      } catch (err) {
        if (isTimeout(err)) {
          throw new PopuliError(
            `Populi did not answer within ${Math.round(timeout / 1000)}s. For slow reports and exports raise ` +
              "`timeout_ms` on the call (or POPULI_TIMEOUT_MS), and check the MCP client's own tool timeout too.",
          );
        }
        if (attempt < attempts) {
          await sleep(500 * attempt);
          continue;
        }
        throw new PopuliError(`Could not reach Populi at ${this.config.baseUrl}: ${describeFetchError(err)}`);
      }
      if (RETRYABLE.has(res.status) && attempt < attempts) {
        await sleep(500 * attempt);
        continue;
      }
      return this.parse(res);
    }
  }

  private assertNotRateLimited(): void {
    const remaining = Math.ceil((this.blockedUntil - Date.now()) / 1000);
    if (remaining > 0) {
      throw new PopuliError(
        `Still inside Populi's rate-limit window (HTTP 429 earlier). Wait about ${remaining}s; no request was sent.`,
        429,
        undefined,
        undefined,
        remaining,
      );
    }
  }

  private async parse(res: Response): Promise<PopuliResponse> {
    const contentType = res.headers.get("content-type") ?? "";

    if (!res.ok) {
      const raw = await res.text();
      let parsed: unknown = raw;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // not JSON: keep the raw text
      }
      throw this.toError(res, parsed);
    }

    if (/json/i.test(contentType) || contentType === "") {
      const raw = await res.text();
      if (!raw.trim()) return { kind: "json", status: res.status, data: null };
      try {
        return { kind: "json", status: res.status, data: JSON.parse(raw) };
      } catch {
        return { kind: "text", status: res.status, contentType, text: raw };
      }
    }
    const filename = filenameFrom(res.headers.get("content-disposition"));
    // File downloads (CSV, XLS, PDF, images) come back as the file itself.
    if (/^text\/|csv|xml/i.test(contentType)) {
      return { kind: "text", status: res.status, contentType, text: await res.text(), filename };
    }
    return { kind: "binary", status: res.status, contentType, data: new Uint8Array(await res.arrayBuffer()), filename };
  }

  private toError(res: Response, body: unknown): PopuliError {
    const obj = body && typeof body === "object" ? (body as Record<string, unknown>) : undefined;
    const code = typeof obj?.code === "string" ? obj.code : undefined;
    const message =
      typeof obj?.message === "string"
        ? obj.message
        : typeof body === "string" && body.trim()
          ? body.trim().slice(0, 300)
          : res.statusText;

    const retryHeader = Number(res.headers.get("retry-after"));
    if (res.status === 429) {
      const retryAfter = Number.isFinite(retryHeader) && retryHeader > 0 ? retryHeader : 65;
      this.blockedUntil = Date.now() + retryAfter * 1000;
      return new PopuliError(
        `Populi rate limit hit (HTTP 429). Wait about ${retryAfter}s before the next call. ` +
          "Limits are 50 requests/min (3AM-7PM PST) and 100/min (7PM-3AM PST) per key.",
        429,
        code,
        body,
        retryAfter,
      );
    }
    const hints: Record<number, string> = {
      401: " Check POPULI_API_KEY (sandbox keys only work on sandbox instances, live keys only on live).",
      403: " The key is valid but its role lacks permission for this route; see the route's roles via populi_describe_api.",
      404: " Check the path and ids.",
    };
    return new PopuliError(
      `Populi HTTP ${res.status}${code ? ` ${code}` : ""}: ${message}${hints[res.status] ?? ""}`,
      res.status,
      code,
      body,
    );
  }
}

function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}

/** The file name Populi suggests for a download, from Content-Disposition. */
export function filenameFrom(header: string | null): string | undefined {
  if (!header) return undefined;
  const star = header.match(/filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/);
  if (star) {
    try {
      return decodeURIComponent(star[1]!.trim());
    } catch {
      // fall through to the plain form
    }
  }
  const plain = header.match(/filename\s*=\s*(?:"([^"]*)"|([^;]+))/);
  return (plain?.[1] ?? plain?.[2])?.trim() || undefined;
}

/**
 * Node's fetch reports every network failure as a bare "fetch failed" and keeps the useful part
 * (ENOTFOUND, ECONNREFUSED, a certificate error) on `cause`. Surface it, or a wrong host name
 * looks the same as a dead network.
 */
export function describeFetchError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause as (Error & { code?: string; errors?: Error[] }) | undefined;
  if (!(cause instanceof Error)) return err.message;
  // On dual-stack hosts a refused connection arrives as an AggregateError with no message of its own
  const detail = cause.message || cause.errors?.[0]?.message;
  const parts = [cause.code && !detail?.includes(cause.code) ? cause.code : undefined, detail].filter(Boolean);
  return parts.length ? `${err.message} (${parts.join(": ")})` : err.message;
}

/**
 * A GET with a JSON body. fetch refuses to send one, but Populi documents it as the normal way to
 * pass parameters, and it has no URL length limit.
 */
export function nodeRequest(url: string, init: BodyGetInit): Promise<Response> {
  const target = new URL(url);
  const send = target.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const headers = { ...init.headers };
    if (init.body !== undefined) headers["Content-Length"] = String(Buffer.byteLength(init.body));
    const req = send(target, { method: init.method, headers, timeout: init.timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("error", reject);
      res.on("end", () => {
        const out = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (Array.isArray(v)) v.forEach((x) => out.append(k, x));
          else if (v !== undefined) out.set(k, v);
        }
        const status = res.statusCode ?? 502;
        const empty = status === 204 || status === 205 || status === 304;
        resolve(
          new Response(empty ? null : (Buffer.concat(chunks) as unknown as BodyInit), {
            status,
            statusText: res.statusMessage,
            headers: out,
          }),
        );
      });
    });
    req.on("timeout", () => req.destroy(Object.assign(new Error("timeout"), { name: "TimeoutError" })));
    req.on("error", reject);
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
