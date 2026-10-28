import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Catalog } from "../lib/catalog.js";
import type { PopuliClient } from "../lib/client.js";
import type { Config } from "../lib/config.js";
import { fail, ok } from "../lib/format.js";

export function registerStatusTool(server: McpServer, config: Config, client: PopuliClient, catalog: Catalog): void {
  server.registerTool(
    "populi_status",
    {
      title: "Populi connection status",
      description:
        "Shows which Populi instance this server talks to, whether the key is a sandbox key, and whether " +
        "writes are enabled. Set `verify` to make one live request that checks the key works.",
      inputSchema: {
        verify: z.boolean().default(false).describe("Make a live request to check the credentials"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ verify }) => {
      const lines = [
        `Instance: ${config.baseUrl}`,
        `Key type: ${config.sandbox ? "sandbox (sk_sandbox_...)" : "live"}`,
        `Writes: ${config.allowWrites ? "enabled (populi_write available)" : "disabled (set POPULI_ALLOW_WRITES=true to enable)"}`,
        `API catalog: ${catalog.ops.length} routes`,
        `Files folder: ${config.filesDir} (downloads are saved here${config.allowWrites ? ", uploads are read from here" : ""})`,
        `Request timeout: ${Math.round(config.timeoutMs / 1000)}s`,
      ];
      if (verify) {
        try {
          await client.request({ method: "GET", path: "/people", params: { limit: 1 } });
          lines.push("Live check: OK (authenticated, GET /people succeeded)");
        } catch (err) {
          const status = (err as { status?: number }).status;
          if (status === 403) {
            lines.push(
              "Live check: authenticated, but this key's role cannot list people. Other routes may still work.",
            );
          } else {
            return fail(`${lines.join("\n")}\nLive check failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
      return ok(lines.join("\n"));
    },
  );
}
