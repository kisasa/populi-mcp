import type { PopuliClient, PopuliResponse } from "./client.js";

/** Safety net for a runaway loop: 500 pages is 100,000 records at Populi's 200 per page. */
const MAX_PAGES = 500;
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
  | {
      kind: "list";
      records: unknown[];
      pagesFetched: number;
      complete: boolean;
      /** Where to pick up if `complete` is false: pass this as `page` to continue. */
      nextPage?: number;
      /** Why paging stopped early, e.g. a rate limit. The records fetched so far are still returned. */
      error?: string;
    }
  /** The route did not return a list, so there is nothing to merge: hand back the raw response. */
  | { kind: "single"; response: PopuliResponse };

/**
 * Walks a list route page by page. Populi takes `page` in the request parameters,
 * not the query string, and caps a page at 200 records.
 *
 * `maxRecords` is a stopping point, not a trim: the page that crosses it is kept whole, so no
 * record is ever dropped and `nextPage` always resumes exactly where this stopped. A failure on
 * page N (a 429, a timeout) keeps pages 1..N-1 and reports where to resume.
 */
export async function fetchAllPages(
  client: PopuliClient,
  path: string,
  params: Record<string, unknown>,
  opts: { startPage: number; maxRecords: number; pageSize?: number; timeoutMs?: number },
): Promise<Paged> {
  const pageSize = opts.pageSize ?? PAGE_SIZE;
  const records: unknown[] = [];
  let page = opts.startPage;
  let fetched = 0;
  let reachedEnd = false;
  let error: string | undefined;

  for (;;) {
    let res: PopuliResponse;
    try {
      res = await client.request({ method: "GET", path, params: { ...params, page }, timeoutMs: opts.timeoutMs });
    } catch (err) {
      if (fetched === 0) throw err;
      error = err instanceof Error ? err.message : String(err);
      break;
    }
    if (res.kind !== "json" || !isList(res.data)) {
      if (fetched === 0) return { kind: "single", response: res };
      reachedEnd = true;
      break;
    }
    fetched++;
    records.push(...res.data.data);

    const totalPages = typeof res.data.pages === "number" ? res.data.pages : undefined;
    reachedEnd = totalPages !== undefined ? page >= totalPages : res.data.data.length < pageSize;
    if (reachedEnd) break;
    page++;
    if (records.length >= opts.maxRecords || fetched >= MAX_PAGES) break;
  }

  return {
    kind: "list",
    records,
    pagesFetched: fetched,
    complete: reachedEnd,
    ...(reachedEnd ? {} : { nextPage: page }),
    ...(error ? { error } : {}),
  };
}
