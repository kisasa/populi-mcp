import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PopuliClient } from "../lib/client.js";
import { DEFAULT_MAX_CHARS, fail, json, ok, renderResponse } from "../lib/format.js";
import { fetchAllPages } from "../lib/paginate.js";

export function registerReadTools(server: McpServer, client: PopuliClient): void {
  server.registerTool(
    "populi_get",
    {
      title: "Read from Populi",
      description:
        "GET any Populi API v2 route (read-only). Path is under /api2, e.g. /people/123, /academicterms, " +
        "/people/123/leads. Lists return up to 200 records per page; use `page`, `limit`, or `all_pages`. " +
        "Use `expand` to inline related records (see populi_describe_api for the allowed names) and `filter` " +
        "to narrow lists. A filter looks like " +
        '{"0":{"logic":"ALL","fields":[{"name":"first_name","value":{"type":"CONTAINS","text":"john"},"positive":1}]}}. ' +
        "Populi allows about 50 requests/min per key, so prefer one filtered call over many unfiltered ones.",
      inputSchema: {
        path: z.string().min(1).describe("Route under /api2, with real ids, e.g. /people/24469940/leads"),
        filter: z.record(z.string(), z.unknown()).optional().describe("Populi filter object (list routes)"),
        expand: z.array(z.string()).optional().describe("Related properties to include"),
        page: z.number().int().min(1).optional().describe("Page of results, 1-based"),
        limit: z.number().int().min(1).max(200).optional().describe("Records per page"),
        params: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Any other documented parameters for the route (sort, report options, ...)"),
        all_pages: z.boolean().default(false).describe("Follow pagination and merge every page into one list"),
        max_records: z
          .number()
          .int()
          .min(1)
          .max(5000)
          .default(500)
          .describe("Cap for all_pages, to bound the number of requests"),
        max_chars: z
          .number()
          .int()
          .min(1000)
          .max(200_000)
          .default(DEFAULT_MAX_CHARS)
          .describe("Truncate the response text beyond this many characters"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ path, filter, expand, page, limit, params, all_pages, max_records, max_chars }) => {
      try {
        const base: Record<string, unknown> = { ...params };
        if (filter) base.filter = filter;
        if (expand?.length) base.expand = expand;
        if (limit) base.limit = limit;
        if (page && !all_pages) base.page = page;

        if (!all_pages) {
          return ok(renderResponse(await client.request({ method: "GET", path, params: base }), max_chars));
        }

        const paged = await fetchAllPages(client, path, base, { startPage: page ?? 1, maxRecords: max_records, pageSize: limit });
        if (paged.kind === "single") return ok(renderResponse(paged.response, max_chars));
        return ok(
          json(
            {
              object: "list",
              results: paged.records.length,
              complete: paged.complete,
              pages_fetched: paged.pagesFetched,
              data: paged.records,
            },
            max_chars,
          ),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "populi_find_people",
    {
      title: "Find people in Populi",
      description:
        "Look up people by email address and/or name. Email is an exact match; first and last name are " +
        "'contains' matches. Returns Populi's people list: ids, names and status, plus a `report_data` block " +
        "with the primary email and phone (contact_primary_email, contact_primary_phone). For full contact " +
        "records fetch /people/{id} with expand=['email_addresses', 'phone_numbers']. Needs at least one criterion.",
      inputSchema: {
        email: z.string().optional().describe("Exact email address"),
        first_name: z.string().optional().describe("Substring of the first name"),
        last_name: z.string().optional().describe("Substring of the last name"),
        limit: z.number().int().min(1).max(200).default(25).describe("Maximum people to return"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ email, first_name, last_name, limit }) => {
      try {
        const fields: unknown[] = [];
        // Populi ignores unknown filter names and returns everyone, so only the documented
        // `email` name is used; `email_address(es)` would silently match the whole list.
        if (email?.trim()) fields.push({ name: "email", value: email.trim(), positive: "1" });
        if (first_name?.trim()) {
          fields.push({ name: "first_name", value: { type: "CONTAINS", text: first_name.trim() }, positive: 1 });
        }
        if (last_name?.trim()) {
          fields.push({ name: "last_name", value: { type: "CONTAINS", text: last_name.trim() }, positive: 1 });
        }
        if (!fields.length) return fail("Provide at least one of email, first_name or last_name.");

        const res = await client.request({
          method: "GET",
          path: "/people",
          params: { filter: { "0": { logic: "ALL", fields } }, limit },
        });
        return ok(renderResponse(res));
      } catch (err) {
        return fail(err);
      }
    },
  );
}
