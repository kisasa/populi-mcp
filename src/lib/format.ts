import { PopuliError, type PopuliResponse } from "./client.js";
import { saveDownload } from "./files.js";

export const DEFAULT_MAX_CHARS = 40_000;
export const MAX_MAX_CHARS = 1_000_000;

export interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

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
