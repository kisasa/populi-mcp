import { PopuliError, type PopuliResponse } from "./client.js";
import { saveDownload } from "./files.js";

export const DEFAULT_MAX_CHARS = 40_000;
export const MAX_MAX_CHARS = 1_000_000;

export type ToolContent =
  | { type: "text"; text: string }
  | { type: "resource"; resource: { uri: string; mimeType: string; blob: string } };

export interface ToolResult {
  [key: string]: unknown;
  content: ToolContent[];
  isError?: boolean;
}

/** Largest file handed back inside a tool result when there is no local files folder (hosted mode). */
export const MAX_INLINE_BYTES = 4 * 1024 * 1024;

export function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

export function fail(err: unknown): ToolResult {
  const message = err instanceof PopuliError ? err.message : err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Pretty JSON, cut at `maxChars` with a note on how to get less back. */
export function json(value: unknown, maxChars = DEFAULT_MAX_CHARS): string {
  const full = JSON.stringify(value, null, 2);
  if (full.length <= maxChars) return full;
  return (
    full.slice(0, maxChars) +
    `\n... [truncated ${full.length - maxChars} of ${full.length} characters. ` +
    "Narrow the response with `filter`, a smaller `limit`, `page`, or fewer `expand` values, " +
    "or use populi_download to save the whole thing to a file.]"
  );
}

/** For the read-only tools: text and JSON inline, files only described. */
export function renderResponse(res: PopuliResponse, maxChars = DEFAULT_MAX_CHARS): string {
  switch (res.kind) {
    case "json":
      return json(res.data, maxChars);
    case "text": {
      const clipped = res.text.length > maxChars;
      return (
        `[${res.contentType || "text"}]\n` +
        (clipped
          ? `${res.text.slice(0, maxChars)}\n... [truncated ${res.text.length - maxChars} characters. Use populi_download to save the whole file.]`
          : res.text)
      );
    }
    case "binary":
      return (
        `Populi returned a file: ${res.filename ?? "unnamed"} (${res.contentType || "binary"}, ${res.data.byteLength} bytes). ` +
        "It can't be shown here. Use populi_download with the same path and parameters to save it to the files folder."
      );
  }
}

/**
 * For populi_download when there is no local disk (hosted server): text and JSON come back as
 * text, a file comes back as an embedded resource, up to MAX_INLINE_BYTES.
 */
export function inlineResponse(res: PopuliResponse, opts: { name?: string; maxChars?: number } = {}): ToolResult {
  if (res.kind !== "binary") return ok(renderResponse(res, opts.maxChars ?? MAX_MAX_CHARS));
  const name = opts.name ?? res.filename ?? "download";
  if (res.data.byteLength > MAX_INLINE_BYTES) {
    return fail(
      `${name} is ${res.data.byteLength} bytes, over the ${MAX_INLINE_BYTES}-byte limit for files returned by a hosted ` +
        "server. Export a smaller range, or run the local populi-mcp server to save large files to disk.",
    );
  }
  return {
    content: [
      { type: "text", text: `Populi returned ${name} (${res.contentType || "binary"}, ${res.data.byteLength} bytes), attached.` },
      {
        type: "resource",
        resource: {
          uri: `populi://download/${encodeURIComponent(name)}`,
          mimeType: res.contentType || "application/octet-stream",
          blob: Buffer.from(res.data).toString("base64"),
        },
      },
    ],
  };
}

/**
 * For populi_download: writes the response into the files folder and says where it went,
 * with a short preview for text and JSON so the model can see it worked.
 */
export async function saveResponse(
  res: PopuliResponse,
  opts: { filesDir: string; name?: string; previewChars?: number },
): Promise<string> {
  const preview = opts.previewChars ?? 1500;
  if (res.kind === "binary") {
    const saved = await saveDownload(opts.filesDir, {
      name: opts.name,
      filename: res.filename,
      contentType: res.contentType,
      data: res.data,
    });
    return `Saved ${saved.path} (${saved.bytes} bytes, ${res.contentType || "binary"}).`;
  }
  if (res.kind === "text") {
    const saved = await saveDownload(opts.filesDir, {
      name: opts.name,
      filename: res.filename,
      contentType: res.contentType,
      data: res.text,
    });
    return `Saved ${saved.path} (${saved.bytes} bytes, ${res.contentType || "text"}).\n\nPreview:\n${res.text.slice(0, preview)}`;
  }
  const text = JSON.stringify(res.data, null, 2);
  const saved = await saveDownload(opts.filesDir, {
    name: opts.name ? (/\.[a-z0-9]+$/i.test(opts.name) ? opts.name : `${opts.name}.json`) : undefined,
    contentType: "application/json",
    data: text,
  });
  return `Saved ${saved.path} (${saved.bytes} bytes, JSON).\n\nPreview:\n${text.slice(0, preview)}${text.length > preview ? "\n..." : ""}`;
}
