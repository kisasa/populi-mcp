#!/usr/bin/env node

import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createRequire } from "node:module";
import { Catalog } from "./lib/catalog.js";
import { PopuliClient } from "./lib/client.js";
import { ConfigError, loadConfig } from "./lib/config.js";
import { createServer } from "./server.js";

// package.json sits one level above dist/ in the published package
const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

async function main(): Promise<void> {
  if (process.argv.includes("--http") || process.env.POPULI_MCP_TRANSPORT === "http") {
    // hosted mode: a remote MCP server with its own sign-in, for Claude and ChatGPT connectors
    const { loadHostedConfig } = await import("./hosted/config.js");
    const { createHostedHandler } = await import("./hosted/server.js");
    const { listen } = await import("./hosted/node.js");
    const hosted = loadHostedConfig();
    const handler = createHostedHandler({ config: hosted, version, log: (line) => console.error(line) });
    await listen(handler, hosted.port);
    console.error(
      `populi-mcp ${version} listening on :${hosted.port} (${hosted.baseUrl ?? "any allowed Populi instance"}, ${
        hosted.allowWrites ? "writes can be enabled by each person" : "read-only"
      })`,
    );
    return;
  }

  const config = loadConfig();
  // serveStdio may build more than one server instance (a discarded server/discover probe, then the
  // real one), so they share one client: one request queue and one rate-limit backoff per process.
  const client = new PopuliClient(config);
  const catalog = Catalog.load();
  serveStdio(() => createServer(config, version, { client, catalog }), {
    onerror: (err) => console.error(`populi-mcp: ${err.message}`),
  });
  // stdout carries the protocol; diagnostics go to stderr only
  console.error(
    `populi-mcp ${version} ready: ${config.baseUrl} (${config.sandbox ? "sandbox" : "live"} key, ${
      config.allowWrites ? "writes enabled" : "read-only"
    })`,
  );
}

main().catch((err) => {
  console.error(err instanceof ConfigError ? `populi-mcp: ${err.message}` : err);
  process.exit(1);
});
