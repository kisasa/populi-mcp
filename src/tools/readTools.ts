import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PopuliClient, PopuliResponse } from "../lib/client.js";
import type { Config } from "../lib/config.js";
import { DEFAULT_MAX_CHARS, fail, MAX_MAX_CHARS, ok, renderResponse, saveResponse } from "../lib/format.js";
import { fetchAllPages } from "../lib/paginate.js";

const FILTER_EXAMPLE =
  '{"0":{"logic":"ALL","fields":[{"name":"first_name","value":{"type":"CONTAINS","text":"john"},"positive":1}]}}';

/** Everything that decides which GET to make, shared by populi_get and populi_download. */
const requestShape = {
  path: z.string().min(1).describe("Route under /api2, with real ids, e.g. /people/24469940/leads"),
  filter: z.record(z.string(), z.unknown()).optional().describe("Populi filter object (list routes)"),
  expand: z.array(z.string()).optional().describe("Related properties to include"),
  page: z.number().int().min(1).optional().describe("Page of results, 1-based. With all_pages, the page to start from"),
  limit: z.number().int().min(1).max(200).optional().describe("Records per page"),
  params: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Any other documented parameters for the route (sort, report options, format, ...)"),
  all_pages: z.boolean().default(false).describe("Follow pagination and merge every page into one list"),
  max_records: z
    .number()
    .int()
    .min(1)
    .max(1_000_000)
    .default(500)
    .describe(
      "With all_pages: stop once at least this many records are collected (the last page is kept whole). " +
        "The result says whether it finished and, if not, the next_page to continue from",
    ),
  timeout_ms: z
    .number()
    .int()
    .min(1000)
    .max(600_000)
    .optional()
    .describe("Per-request timeout. Raise for slow reports and exports (default 120000)"),
};
const requestObject = z.object(requestShape);
type RequestArgs = z.infer<typeof requestObject>;

function buildParams(a: RequestArgs): Record<string, unknown> {
  const base: Record<string, unknown> = { ...a.params };
  if (a.filter) base.filter = a.filter;
  if (a.expand?.length) base.expand = a.expand;
  if (a.limit) base.limit = a.limit;
  if (a.page && !a.all_pages) base.page = a.page;
  return base;
}

/** One GET, or every page merged into one list object. Non-list responses pass through untouched. */
async function fetchRequested(client: PopuliClient, a: RequestArgs): Promise<PopuliResponse> {
  const params = buildParams(a);
  if (!a.all_pages) return client.request({ method: "GET", path: a.path, params, timeoutMs: a.timeout_ms });

  const paged = await fetchAllPages(client, a.path, params, {
    startPage: a.page ?? 1,
    maxRecords: a.max_records,
    pageSize: a.limit,
    timeoutMs: a.timeout_ms,
  });
  if (paged.kind === "single") return paged.response;
  return {
    kind: "json",
    status: 200,
    data: {
      object: "list",
      results: paged.records.length,
      complete: paged.complete,
      pages_fetched: paged.pagesFetched,
      ...(paged.nextPage !== undefined ? { next_page: paged.nextPage } : {}),
      ...(paged.error ? { error: paged.error } : {}),
      data: paged.records,
    },
  };
}

export function registerReadTools(server: McpServer, client: PopuliClient, config: Pick<Config, "filesDir">): void {
  server.registerTool(
    "populi_get",
    {
      title: "Read from Populi",
      description:
        "GET any Populi API v2 route (read-only). Path is under /api2, e.g. /people/123, /academicterms, " +
        "/people/123/leads. Lists return up to 200 records per page; use `page`, `limit`, or `all_pages`. " +
        "Use `expand` to inline related records (see populi_describe_api for the allowed names) and `filter` " +
        `to narrow lists. A filter looks like ${FILTER_EXAMPLE}. ` +
        "Populi allows about 50 requests/min per key, so prefer one filtered call over many unfiltered ones. " +
        "Routes that return a file (PDF/XLS exports, transcripts, Data Slicer results, file downloads) can't be " +
        "shown here: use populi_download for those. If a rate limit stops all_pages part-way, the pages already " +
        "fetched are returned with a next_page to resume from.",
      inputSchema: {
        ...requestShape,
        max_chars: z
          .number()
          .int()
          .min(1000)
          .max(MAX_MAX_CHARS)
          .default(DEFAULT_MAX_CHARS)
          .describe("Truncate the response text beyond this many characters"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ max_chars, ...args }) => {
      try {
        return ok(renderResponse(await fetchRequested(client, args), max_chars));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "populi_download",
    {
      title: "Download from Populi to a file",
      description:
        "GET a Populi route and save the response to a file in the files folder instead of returning it. " +
        "Use it for routes that return files (PDF/XLS/CSV exports, transcripts and grade reports, Data Slicer " +
        "results, file and backup downloads, images) and to keep a big list or full export out of the " +
        "conversation (use all_pages). Takes the same arguments as populi_get. Never overwrites: an existing " +
        "name gets -1, -2, ... appended. Returns the saved path and a short preview.",
      inputSchema: {
        ...requestShape,
        save_as: z
          .string()
          .min(1)
          .optional()
          .describe("File name to save under (no folders). Defaults to the name Populi suggests, or a timestamp"),
      },
      // writes only new files, only inside the files folder, and never overwrites
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ save_as, ...args }) => {
      try {
        const res = await fetchRequested(client, args);
        return ok(await saveResponse(res, { filesDir: config.filesDir, name: save_as }));
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
