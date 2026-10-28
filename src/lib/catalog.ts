import { readFileSync } from "node:fs";

export interface Param {
  name: string;
  required: boolean;
  type: string;
  description: string;
}

export interface Operation {
  /** `<model>.<op>`, e.g. `people.create`. */
  id: string;
  model: string;
  op: string;
  title: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
  /** As documented, with `(placeholder)` path params, e.g. `/people/(person)`. */
  path: string;
  pathParams: string[];
  description: string;
  roles: string[];
  params: Param[];
  actionParams: { name: string; type: string; description: string }[];
  expand: string[];
  filters: { name: string; type: string }[];
  doc: string;
}

interface CatalogFile {
  source: string;
  ops: Operation[];
}

// dist/lib/catalog.js and src/lib/catalog.ts both sit two levels below the package root.
const CATALOG_URL = new URL("../../data/catalog.json", import.meta.url);

export class Catalog {
  private readonly byId = new Map<string, Operation>();
  private readonly matchers: { re: RegExp; op: Operation }[];

  constructor(readonly ops: Operation[]) {
    for (const op of ops) this.byId.set(op.id, op);
    this.matchers = ops.map((op) => ({
      op,
      re: new RegExp(
        "^" + op.path.split(/\([a-z_]+\)/).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^/]+") + "$",
      ),
    }));
  }

  static load(): Catalog {
    const file = JSON.parse(readFileSync(CATALOG_URL, "utf8")) as CatalogFile;
    return new Catalog(file.ops);
  }

  get(id: string): Operation | undefined {
    return this.byId.get(id.trim().toLowerCase());
  }

  /** The documented operation a concrete request path like `/people/123` corresponds to. */
  match(method: string, path: string): Operation | undefined {
    const clean = "/" + path.trim().replace(/^\/?api2(?=\/|$)/, "").replace(/^\/+|\/+$/g, "");
    return this.matchers.find((m) => m.op.method === method && m.re.test(clean))?.op;
  }

  search(query: string, opts: { method?: string; limit?: number } = {}): Operation[] {
    const tokens = query
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((t) => t.length > 1 || /^\d$/.test(t));
    const pool = opts.method ? this.ops.filter((o) => o.method === opts.method) : this.ops;
    if (!tokens.length) return pool.slice(0, opts.limit ?? 15);

    const scored = pool.map((op) => {
      const id = op.id.toLowerCase();
      // Field names are indexed at low weight so "application status" can narrow to the routes
      // that actually have a status filter, instead of matching on the word "application" alone.
      const names = [...op.params.map((p) => p.name), ...op.filters.map((f) => f.name), ...op.expand]
        .join(" ")
        .toLowerCase();
      const model = op.model.toLowerCase();
      const fields: [string, number][] = [
        [id, 4],
        [op.title.toLowerCase(), 3],
        [op.path.toLowerCase(), 2],
        [op.description.toLowerCase(), 1],
        [names, 1],
      ];
      let score = 0;
      let matched = 0;
      for (const t of tokens) {
        let hit = fields.reduce((s, [text, w]) => (text.includes(t) ? s + w : s), 0);
        // A word that names the model itself (application -> applications) beats a substring of
        // another model's name (aidapplications), which would otherwise win ties alphabetically.
        // The title is the singular model name ("Person" for people), which covers irregular plurals.
        if (t === model || `${t}s` === model || `${model}s` === t || t === op.title.toLowerCase()) hit += 6;
        if (hit) matched++;
        score += hit;
      }
      if (id === query.trim().toLowerCase()) score += 20;
      return { op, score, matched };
    });

    const all = scored.filter((s) => s.matched === tokens.length);
    // Equal scores are common within one model (create/index/show/update/delete all mention it).
    // Reads first, since most searches are looking for something to read, then alphabetical.
    const methodRank = (m: string) => ["GET", "POST", "PUT", "DELETE"].indexOf(m);
    const hits = (all.length ? all : scored.filter((s) => s.score > 0)).sort(
      (a, b) =>
        b.score - a.score || methodRank(a.op.method) - methodRank(b.op.method) || a.op.id.localeCompare(b.op.id),
    );
    return hits.slice(0, opts.limit ?? 15).map((s) => s.op);
  }
}

/** The routes the docs show uploading a file (multipart) to. */
const UPLOAD_ROUTE = /\/(upload_file|update_profile_picture|update_image|digitalresources\/upload)$/;
/** Routes documented as returning a PDF/XLS/CSV or a stored file instead of JSON. */
const DOWNLOAD_ROUTE =
  /\/(download|export_pdf|export_transcript|gradereport|idcard)$|^\/dataslicerreports\/\([a-z_]+\)\/results$/;

export function summarize(op: Operation): string {
  const desc = op.description ? ` ${op.description}` : "";
  return `${op.id}  ${op.method} ${op.path}${desc}`;
}

/** Everything a model needs to build a correct call, as plain text. */
export function describe(op: Operation): string {
  const lines = [`${op.id}: ${op.method} ${op.path}`, `Model: ${op.title}`];
  if (op.description) lines.push(op.description);
  if (op.pathParams.length) {
    lines.push(`Path placeholders (replace with real ids): ${op.pathParams.map((p) => `(${p})`).join(", ")}`);
  }
  lines.push(op.roles.length ? `Roles (any one): ${op.roles.join(", ")}` : "Roles: not documented");

  if (op.params.length) {
    lines.push("", op.method === "GET" ? "Parameters (go in `params`):" : "Body fields:");
    for (const p of op.params) {
      lines.push(`- ${p.name}${p.required ? " (required)" : ""}: ${p.type}${p.description ? ` - ${p.description}` : ""}`);
    }
  }
  if (op.actionParams.length) {
    lines.push("", "Action parameters (nest under an `actions` key in the body):");
    for (const p of op.actionParams) lines.push(`- ${p.name}: ${p.type}${p.description ? ` - ${p.description}` : ""}`);
  }
  if (op.expand.length) lines.push("", `Expandable (pass as \`expand\`): ${op.expand.join(", ")}`);
  if (op.filters.length) {
    lines.push("", "Filter conditions (use inside `filter`):", op.filters.map((f) => `${f.name} (${f.type})`).join(", "));
  }
  if (op.method !== "GET" && UPLOAD_ROUTE.test(op.path)) {
    lines.push(
      "",
      "File upload: call populi_write with `files` (a path inside the files folder, or content_base64). " +
        "The fields listed above go in `body` and are sent as the multipart `parameters` part.",
    );
  }
  if (op.method === "GET" && DOWNLOAD_ROUTE.test(op.path)) {
    lines.push("", "This route returns a file, not JSON. Use populi_download to save it to the files folder.");
  }
  lines.push("", `Docs: ${op.doc}`);
  return lines.join("\n");
}
