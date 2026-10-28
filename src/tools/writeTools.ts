import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Catalog } from "../lib/catalog.js";
import type { PopuliClient } from "../lib/client.js";
import type { Config } from "../lib/config.js";
import { fail, ok, renderResponse } from "../lib/format.js";
import { readUpload } from "../lib/files.js";

const fileSpec = z.object({
  path: z
    .string()
    .optional()
    .describe("File inside the files folder (relative to it, or an absolute path within it)"),
  content_base64: z.string().optional().describe("Alternative to path: the file's bytes, base64-encoded"),
  filename: z.string().optional().describe("Name to give the upload. Defaults to the file's own name"),
  content_type: z.string().optional().describe("MIME type. Guessed from the file name if omitted"),
  field: z.string().optional().describe("Form field name. Populi's upload routes use `file` (the default)"),
});

/** Only registered when POPULI_ALLOW_WRITES is set, so a read-only server never exposes it. */
export function registerWriteTools(
  server: McpServer,
  client: PopuliClient,
  catalog: Catalog,
  config: Pick<Config, "filesDir">,
): void {
  server.registerTool(
    "populi_write",
    {
      title: "Write to Populi",
      description:
        "Create, update or delete Populi records: POST creates, PUT updates, DELETE removes. " +
        "This changes a real student information system, and DELETE is permanent. " +
        "Look the route up with populi_describe_api first and send exactly the documented body fields. " +
        "Action parameters go under an `actions` key inside `body`. " +
        "To upload a file (e.g. POST /people/{id}/upload_file, /people/{id}/update_profile_picture), pass `files`; " +
        "the other fields then travel in the multipart `parameters` part. Files must be inside the files folder, " +
        "or be passed as base64. Confirm destructive or bulk changes with the user before calling.",
      inputSchema: {
        method: z.enum(["POST", "PUT", "DELETE"]).describe("POST = create, PUT = update, DELETE = remove"),
        path: z.string().min(1).describe("Route under /api2 with real ids, e.g. /people/24469752/emailaddresses/21648043"),
        body: z.record(z.string(), z.unknown()).optional().describe("JSON body fields for the route"),
        files: z.array(fileSpec).max(10).optional().describe("Files to upload as multipart/form-data (POST or PUT)"),
        timeout_ms: z
          .number()
          .int()
          .min(1000)
          .max(600_000)
          .optional()
          .describe("Per-request timeout. Raise for large uploads (default 120000)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ method, path, body, files, timeout_ms }) => {
      try {
        const uploads = files?.length ? await Promise.all(files.map((f) => readUpload(config.filesDir, f))) : undefined;
        const op = catalog.match(method, path);
        const res = await client.request({ method, path, params: body, files: uploads, timeoutMs: timeout_ms });
        const note = op
          ? ""
          : `\n\n(Note: ${method} ${path} does not match a documented route in the bundled catalog. ` +
            "Verify the result.)";
        return ok(renderResponse(res) + note);
      } catch (err) {
        return fail(err);
      }
    },
  );
}
