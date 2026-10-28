#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRequire } from "node:module";
import { ConfigError, loadConfig } from "./lib/config.js";
import { createServer } from "./server.js";

// package.json sits one level above dist/ in the published package
const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

async function main(): Promise<void> {
  const config = loadConfig();
  const server = createServer(config, version);
  await server.connect(new StdioServerTransport());
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
