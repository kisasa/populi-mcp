import { PopuliError, type PopuliResponse } from "./client.js";

export const DEFAULT_MAX_CHARS = 40_000;

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
    "Narrow the response with `filter`, a smaller `limit`, `page`, or fewer `expand` values.]"
  );
}

export function renderResponse(res: PopuliResponse, maxChars = DEFAULT_MAX_CHARS): string {
  switch (res.kind) {
    case "json":
      return json(res.data, maxChars);
    case "text": {
      const clipped = res.text.length > maxChars;
      return (
        `[${res.contentType || "text"}]\n` +
        (clipped ? `${res.text.slice(0, maxChars)}\n... [truncated ${res.text.length - maxChars} characters]` : res.text)
      );
    }
    case "binary":
      return `Populi returned a ${res.contentType || "binary"} file (${res.bytes} bytes). Binary downloads cannot be shown here.`;
  }
}
