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

export type PopuliResponse =
  | { kind: "json"; status: number; data: unknown }
  | { kind: "text"; status: number; contentType: string; text: string }
  | { kind: "binary"; status: number; contentType: string; bytes: number };

export interface RequestOptions {
  method: HttpMethod;
  /** Route under /api2, e.g. `/people/123`. Leading slash optional. */
  path: string;
  /**
   * Request parameters (filter, expand, page, limit, or a write body).
   * GET sends them as the `parameters` query value, since many HTTP stacks
   * (including fetch) cannot send a GET body. Everything else sends a JSON body.
   */
  params?: Record<string, unknown>;
}

const RETRYABLE = new Set([502, 503, 504]);
const TIMEOUT_MS = 30_000;

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
  constructor(
    private readonly config: Pick<Config, "baseUrl" | "apiKey">,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async request({ method, path, params }: RequestOptions): Promise<PopuliResponse> {
    let url = `${this.config.baseUrl}/${cleanPath(path)}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.apiKey}`,
      Accept: "application/json",
    };
    let body: string | undefined;
    const hasParams = params !== undefined && Object.keys(params).length > 0;

    if (method === "GET") {
      if (hasParams) url += `?${new URLSearchParams({ parameters: JSON.stringify(params) })}`;
    } else {
      // Populi answers 400 invalid_json to a POST without this, even for an empty body.
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(params ?? {});
    }

    const attempts = method === "GET" ? 3 : 1; // never replay a write
    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(url, { method, headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
      } catch (err) {
        if (attempt < attempts) {
          await sleep(500 * attempt);
          continue;
        }
        const reason = err instanceof Error ? err.message : String(err);
        throw new PopuliError(`Could not reach Populi at ${this.config.baseUrl}: ${reason}`);
      }
      if (RETRYABLE.has(res.status) && attempt < attempts) {
        await sleep(500 * attempt);
        continue;
      }
      return this.parse(res);
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
    // File downloads (CSV, XLS, PDF, images) come back as the file itself.
    if (/^text\/|csv|xml/i.test(contentType)) {
      return { kind: "text", status: res.status, contentType, text: await res.text() };
    }
    const buf = await res.arrayBuffer();
    return { kind: "binary", status: res.status, contentType, bytes: buf.byteLength };
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
