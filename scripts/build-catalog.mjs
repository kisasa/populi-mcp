#!/usr/bin/env node
// Scrapes https://populi.co/api (Populi API v2 reference) into data/catalog.json.
//
// The docs publish no OpenAPI file, so this reads the rendered HTML: one page per
// model under models/, one <h2> per operation, <h3> sub-sections for the HTTP
// request line, parameter tables, expandable properties, filter conditions and
// permissions. Run `npm run build:catalog` when Populi ships API changes and
// commit the diff.

import { mkdirSync, writeFileSync } from "node:fs";

const DOCS = "https://populi.co/api/";
const OUT = new URL("../data/catalog.json", import.meta.url);
const CONCURRENCY = 4;

const ENTITIES = { "&quot;": '"', "&amp;": "&", "&lt;": "<", "&gt;": ">", "&#39;": "'", "&nbsp;": " " };

function text(html) {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&(quot|amp|lt|gt|#39|nbsp);/g, (m) => ENTITIES[m] ?? m)
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchText(url, attempt = 1) {
  const res = await fetch(url, { headers: { "User-Agent": "populi-mcp catalog builder" } });
  if (res.ok) return res.text();
  if (attempt < 4 && res.status >= 500) {
    await new Promise((r) => setTimeout(r, 500 * attempt));
    return fetchText(url, attempt + 1);
  }
  throw new Error(`${url} -> ${res.status}`);
}

function rows(tableHtml) {
  const body = tableHtml.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1] ?? "";
  return [...body.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((tr) =>
    [...tr[1].matchAll(/<td>([\s\S]*?)<\/td>/g)].map((td) => text(td[1])),
  );
}

function listItems(html) {
  return [...html.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => text(m[1])).filter(Boolean);
}

function parseOperation(model, page, h2Id, name, html) {
  const request = html.match(/<h3 id='http-request[^']*'>HTTP Request<\/h3>\s*<p><code>([A-Z]+) ([^<]+)<\/code>/);
  if (!request) return null; // the "The X object" sections have no request line

  const [, method, rawPath] = request;
  const head = html.slice(0, request.index);
  const description = [...head.replace(/<blockquote>[\s\S]*?<\/blockquote>/g, "").matchAll(/<p>([\s\S]*?)<\/p>/g)]
    .map((m) => text(m[1]))
    .filter(Boolean)
    .join(" ");

  const op = {
    id: `${model}.${name}`,
    model,
    op: name,
    title: model,
    method,
    path: rawPath.trim(),
    pathParams: [...rawPath.matchAll(/\(([a-z_]+)\)/g)].map((m) => m[1]),
    description,
    roles: [],
    params: [],
    actionParams: [],
    expand: [],
    filters: [],
    doc: `${DOCS}models/${page}#${h2Id}`,
  };

  const sections = html.split(/(?=<h3 id=')/);
  for (const section of sections) {
    const title = section.match(/^<h3 id='[^']*'>([^<]*)<\/h3>/)?.[1];
    if (!title) continue;
    const table = section.match(/<table>[\s\S]*?<\/table>/)?.[0];
    switch (title) {
      case "Parameters":
        if (table) {
          op.params = rows(table).map(([n, required, type, desc]) => ({
            name: n,
            required: required === "Yes",
            type: type ?? "",
            description: desc ?? "",
          }));
        }
        break;
      case "Action Parameters":
        if (table) {
          op.actionParams = rows(table).map(([n, type, desc]) => ({
            name: n,
            type: type ?? "",
            description: desc ?? "",
          }));
        }
        break;
      case "Expandable Properties":
        op.expand = listItems(section);
        break;
      case "Filter Condition Parameters":
        if (table) op.filters = rows(table).map(([n, type]) => ({ name: n, type: type ?? "" }));
        break;
      case "Permissions":
        op.roles = listItems(section);
        break;
    }
  }
  return op;
}

function parsePage(page, html) {
  const model = page.replace(/\.html$/, "");
  const title = html.match(/<h1 id='[^']*'>([^<]*)<\/h1>/)?.[1] ?? model;
  const parts = html.split(/(?=<h2 id=')/);
  const ops = [];
  const seen = new Map();
  for (const part of parts) {
    const m = part.match(/^<h2 id='([^']*)'>([^<]*)<\/h2>/);
    if (!m) continue;
    const op = parseOperation(model, page, m[1], text(m[2]), part);
    if (!op) continue;
    op.title = text(title);
    const n = (seen.get(op.id) ?? 0) + 1;
    seen.set(op.id, n);
    if (n > 1) op.id = `${op.id}_${n}`;
    ops.push(op);
  }
  return ops;
}

async function pool(items, worker) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await worker(items[i]);
      }
    }),
  );
  return out;
}

const index = await fetchText(DOCS);
const pages = [...new Set([...index.matchAll(/models\/([a-z0-9_]+\.html)/g)].map((m) => m[1]))].sort();
if (pages.length < 100) throw new Error(`Expected ~180 model pages in the docs index, found ${pages.length}`);

console.error(`Fetching ${pages.length} model pages...`);
const perPage = await pool(pages, async (page) => parsePage(page, await fetchText(`${DOCS}models/${page}`)));
const ops = perPage.flat();

const byMethod = {};
for (const op of ops) byMethod[op.method] = (byMethod[op.method] ?? 0) + 1;

mkdirSync(new URL("../data/", import.meta.url), { recursive: true });
writeFileSync(OUT, JSON.stringify({ source: DOCS, ops }) + "\n");
console.error(`Wrote ${ops.length} operations from ${pages.length} pages`, byMethod);
