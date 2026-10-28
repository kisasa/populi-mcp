import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Catalog } from "./lib/catalog.js";
import { PopuliClient } from "./lib/client.js";
import type { Config } from "./lib/config.js";
import { registerCatalogTools } from "./tools/catalogTools.js";
import { registerReadTools } from "./tools/readTools.js";
import { registerStatusTool } from "./tools/statusTool.js";
import { registerWriteTools } from "./tools/writeTools.js";

const INSTRUCTIONS = `Populi is a student information system (people, admissions, academics, billing). This server exposes its API v2.

Workflow: populi_search_api to find a route, populi_describe_api for its parameters, then populi_get to read. Use populi_find_people to look up a person by email or name.
- List routes return at most 200 records per page and the key is limited to about 50 requests per minute, so filter on the server side (\`filter\`) instead of paging everything.
- Many routes need a path id (e.g. /people/{id}); replace placeholders such as (person) with real ids.
- Fetching a person returns their record, not their contact details, unless you pass expand (e.g. email_addresses, phone_numbers).
- Records can contain sensitive student data (SSNs, birthdates, grades, financial aid). Request only the fields and expands you need.`;

export function createServer(config: Config, version: string, deps: { client?: PopuliClient; catalog?: Catalog } = {}): McpServer {
  const client = deps.client ?? new PopuliClient(config);
  const catalog = deps.catalog ?? Catalog.load();

  const server = new McpServer(
    { name: "populi-mcp", version },
    {
      instructions: config.allowWrites
        ? `${INSTRUCTIONS}\n- Writes are enabled: populi_write changes live data. Confirm with the user before create, update or delete calls.`
        : `${INSTRUCTIONS}\n- This server is read-only; creating, updating and deleting records is disabled.`,
    },
  );

  registerStatusTool(server, config, client, catalog);
  registerCatalogTools(server, catalog);
  registerReadTools(server, client);
  if (config.allowWrites) registerWriteTools(server, client, catalog);

  return server;
}
