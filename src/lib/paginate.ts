import type { PopuliClient, PopuliResponse } from "./client.js";

const MAX_PAGES = 50;
/** Populi returns at most this many records per page. */
const PAGE_SIZE = 200;

interface ListBody {
  data: unknown[];
  pages?: number;
}

function isList(value: unknown): value is ListBody {
  return !!value && typeof value === "object" && Array.isArray((value as ListBody).data);
}

export type Paged =
  | { kind: "list"; records: unknown[]; pagesFetched: number; complete: boolean }
  /** The route did not return a list, so there is nothing to merge: hand back the raw response. */
  | { kind: "single"; response: PopuliResponse };

/**
 * Walks a list route page by page. Populi takes `page` in the request parameters,
 * not the query string, and caps a page at 200 records.
 */
export async function fetchAllPages(
  client: PopuliClient,
  path: string,
  params: Record<string, unknown>,
  opts: { startPage: number; maxRecords: number; pageSize?: number },
): Promise<Paged> {
  const pageSize = opts.pageSize ?? PAGE_SIZE;
  const records: unknown[] = [];
  let page = opts.startPage;
  let fetched = 0;
  let reachedEnd = false;

  for (;;) {
    const res = await client.request({ method: "GET", path, params: { ...params, page } });
    if (res.kind !== "json" || !isList(res.data)) {
      if (fetched === 0) return { kind: "single", response: res };
      reachedEnd = true;
      break;
    }
    fetched++;
    records.push(...res.data.data);

    const totalPages = typeof res.data.pages === "number" ? res.data.pages : undefined;
    reachedEnd = totalPages !== undefined ? page >= totalPages : res.data.data.length < pageSize;
    if (reachedEnd || records.length >= opts.maxRecords || fetched >= MAX_PAGES) break;
    page++;
  }

  const capped = records.slice(0, opts.maxRecords);
  return {
    kind: "list",
    records: capped,
    pagesFetched: fetched,
    complete: reachedEnd && capped.length === records.length,
  };
}
