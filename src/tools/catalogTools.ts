import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { describe, summarize, type Catalog } from "../lib/catalog.js";
import { fail, ok } from "../lib/format.js";

export function registerCatalogTools(server: McpServer, catalog: Catalog): void {
  server.registerTool(
    "populi_search_api",
    {
      title: "Search Populi API routes",
      description:
        "Search the Populi API v2 route catalog (697 routes across 180 models) by keyword, e.g. 'application', " +
        "'enrollments', 'invoice', 'course offering'. Returns route ids with method and path. " +
        "Use this first to find the right route, then populi_describe_api for its parameters.",
      inputSchema: {
        query: z.string().min(1).describe("Keywords, or an exact route id like people.create"),
        method: z.enum(["GET", "POST", "PUT", "DELETE"]).optional().describe("Only routes with this HTTP method"),
        limit: z.number().int().min(1).max(50).default(15).describe("Maximum routes to return"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ query, method, limit }) => {
      try {
        const hits = catalog.search(query, { method, limit });
        if (!hits.length) return ok(`No routes match "${query}". Try fewer or broader keywords.`);
        return ok(`${hits.length} route(s):\n${hits.map(summarize).join("\n")}`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "populi_describe_api",
    {
      title: "Describe a Populi API route",
      description:
        "Full reference for one route: path placeholders, required/optional parameters with types, expandable " +
        "properties, filter conditions, required Populi roles, and a link to the docs. " +
        "Pass a route id from populi_search_api, or a concrete method and path.",
      inputSchema: {
        id: z.string().optional().describe("Route id such as people.show"),
        method: z.enum(["GET", "POST", "PUT", "DELETE"]).optional().describe("With `path`, to look a route up by URL"),
        path: z.string().optional().describe("A route path such as /people/123 or /people/(person)"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ id, method, path }) => {
      try {
        const op = id ? catalog.get(id) : method && path ? catalog.match(method, path) : undefined;
        if (!op) {
          return fail(
            id
              ? `No route with id "${id}". Use populi_search_api to find ids.`
              : "Provide `id`, or both `method` and `path`. If you passed those, no documented route matched.",
          );
        }
        return ok(describe(op));
      } catch (err) {
        return fail(err);
      }
    },
  );
}
