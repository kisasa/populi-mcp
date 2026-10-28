import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Catalog } from "../lib/catalog.js";
import type { PopuliClient } from "../lib/client.js";
import { fail, ok, renderResponse } from "../lib/format.js";

/** Only registered when POPULI_ALLOW_WRITES is set, so a read-only server never exposes it. */
export function registerWriteTools(server: McpServer, client: PopuliClient, catalog: Catalog): void {
  server.registerTool(
    "populi_write",
    {
      title: "Write to Populi",
      description:
        "Create, update or delete Populi records: POST creates, PUT updates, DELETE removes. " +
        "This changes a real student information system, and DELETE is permanent. " +
        "Look the route up with populi_describe_api first and send exactly the documented body fields. " +
        "Action parameters go under an `actions` key inside `body`. Confirm destructive or bulk changes " +
        "with the user before calling.",
      inputSchema: {
        method: z.enum(["POST", "PUT", "DELETE"]).describe("POST = create, PUT = update, DELETE = remove"),
        path: z.string().min(1).describe("Route under /api2 with real ids, e.g. /people/24469752/emailaddresses/21648043"),
        body: z.record(z.string(), z.unknown()).optional().describe("JSON body fields for the route"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ method, path, body }) => {
      try {
        const op = catalog.match(method, path);
        const res = await client.request({ method, path, params: body });
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
