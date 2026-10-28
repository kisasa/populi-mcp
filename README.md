# populi-mcp

MCP server for the [Populi](https://populi.co/api) API v2. It lets Claude, Codex, Cursor and any other [Model Context Protocol](https://modelcontextprotocol.io) client look up people, admissions, academics and billing data in your Populi instance, and, if you opt in, make changes.

**Package:** `@kisasa/populi-mcp` on npm. **Command:** `populi-mcp`. **Transport:** stdio.

## How it works

Populi's API has 697 routes across 180 models. Exposing each as its own tool would flood a model's context, so this server gives the model a small toolset plus the API reference itself:

| Tool | What it does |
|------|--------------|
| `populi_search_api` | Keyword search over the bundled route catalog (`applications`, `invoice`, `enrollments`, ...). |
| `populi_describe_api` | Full reference for one route: path ids, required and optional fields with types, `expand` options, filter conditions, required Populi roles, docs link. |
| `populi_get` | `GET` any route. Supports `filter`, `expand`, `page`, `limit`, and `all_pages` to merge every page into one list. |
| `populi_find_people` | Look up people by exact email and/or name. |
| `populi_status` | Shows the instance, key type (sandbox or live) and whether writes are on. `verify: true` makes one live request to check the key. |
| `populi_write` | `POST` / `PUT` / `DELETE` any route. **Only exists when `POPULI_ALLOW_WRITES=true`.** |

A typical exchange: the model searches for the route, reads its parameters, then calls `populi_get` with a server-side filter.

The catalog is generated from the public API docs and ships inside the package, so searching and describing work offline and cost no API requests.

## Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `POPULI_BASE_URL` | yes | Your instance, e.g. `https://yourschool.populiweb.com`. A trailing `/api2` is fine and optional. Must be `https`. |
| `POPULI_API_KEY` | yes | An API key token. In Populi: **Account & Settings > API > Keys** (Account Administrator). Sent as a bearer token to `POPULI_BASE_URL` only. |
| `POPULI_ALLOW_WRITES` | no | Set to `true` to enable `populi_write`. Default: read-only. |

The key's Populi roles decide what it can see. A route the key cannot reach returns a 403 naming the problem; `populi_describe_api` lists the roles each route needs.

### Sandbox first

Populi issues separate `sk_sandbox_...` keys that only work against sandbox instances (live keys only work on live). Point this server at a sandbox while you evaluate it.

### Read-only by default

With no `POPULI_ALLOW_WRITES`, the write tool is not registered at all, so the model cannot even attempt a change. When you enable it, `populi_write` is marked destructive, so clients that prompt for approval will ask before each call. `DELETE` in Populi is permanent.

## Install

Requires Node.js 20 or newer. Every client below runs `npx -y @kisasa/populi-mcp`, so there is nothing to install by hand.

### Claude Code

```bash
claude mcp add populi \
  -e POPULI_BASE_URL=https://yourschool.populiweb.com \
  -e POPULI_API_KEY=sk_sandbox_... \
  -- npx -y @kisasa/populi-mcp
```

### Claude Desktop

Edit `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`):

```json
{
  "mcpServers": {
    "populi": {
      "command": "npx",
      "args": ["-y", "@kisasa/populi-mcp"],
      "env": {
        "POPULI_BASE_URL": "https://yourschool.populiweb.com",
        "POPULI_API_KEY": "sk_sandbox_..."
      }
    }
  }
}
```

On Windows, if Claude Desktop cannot find `npx`, use `"command": "cmd"` with `"args": ["/c", "npx", "-y", "@kisasa/populi-mcp"]`.

### Codex

```bash
codex mcp add populi \
  --env POPULI_BASE_URL=https://yourschool.populiweb.com \
  --env POPULI_API_KEY=sk_sandbox_... \
  -- npx -y @kisasa/populi-mcp
```

or in `~/.codex/config.toml`:

```toml
[mcp_servers.populi]
command = "npx"
args = ["-y", "@kisasa/populi-mcp"]

[mcp_servers.populi.env]
POPULI_BASE_URL = "https://yourschool.populiweb.com"
POPULI_API_KEY = "sk_sandbox_..."
```

### Cursor

In `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global). Cursor expands `${env:NAME}`, which keeps the key out of the file:

```json
{
  "mcpServers": {
    "populi": {
      "command": "npx",
      "args": ["-y", "@kisasa/populi-mcp"],
      "env": {
        "POPULI_BASE_URL": "https://yourschool.populiweb.com",
        "POPULI_API_KEY": "${env:POPULI_API_KEY}"
      }
    }
  }
}
```

### Any other MCP client

Run `npx -y @kisasa/populi-mcp` as a stdio server with `POPULI_BASE_URL` and `POPULI_API_KEY` in its environment.

### More than one instance

Add one entry per instance under different names (`populi-sandbox`, `populi-live`), each with its own key.

## API behaviors worth knowing

- **Rate limits.** 50 requests/min per key from 3AM-7PM PST, 100/min overnight, plus per-IP and per-school limits. On HTTP 429 the tool returns an error telling the model how long to wait instead of blocking. Prefer one filtered call over many unfiltered ones.
- **Pages.** Lists return at most 200 records. `all_pages` merges pages up to `max_records` (default 500) and reports whether it got everything.
- **Filters.** Populi ignores filter field names it does not know and returns the *whole list*, which looks like "everyone matches". `populi_describe_api` lists the valid condition names for a route; `populi_find_people` uses the right ones for people.
- **GET parameters.** `filter`, `expand`, `page` and `limit` travel in a `parameters` query value, because most HTTP clients cannot send a GET body. `POST`/`PUT`/`DELETE` send a JSON body.
- **Large responses** are truncated at `max_chars` (default 40,000) with a note on how to narrow the request.
- **File downloads** (CSV, XLS, PDF): text formats are returned as text; binary files are reported by size only.
- **Student data is sensitive.** Records can include SSNs, birthdates, grades and financial aid. The server never logs request or response bodies, and the key is never echoed in errors, but whatever a tool returns goes to your model provider. Use the narrowest key role and `expand` you need.

## Development

```bash
git clone https://github.com/kisasa/populi-mcp.git
cd populi-mcp
npm install
npm run build      # compile to dist/
npm test           # unit + in-memory MCP tests, no network
```

Try it against a real instance:

```bash
POPULI_BASE_URL=https://yourschool.populiweb.com POPULI_API_KEY=sk_sandbox_... \
  npx @modelcontextprotocol/inspector node dist/index.js
```

### Refreshing the API catalog

`data/catalog.json` is scraped from the rendered API docs (Populi publishes no OpenAPI file):

```bash
npm run build:catalog
```

Review and commit the diff when Populi ships API changes.

### Releasing

Publishing is automated by `.github/workflows/publish.yml` on every push to `main`, and only acts when the version is new. To release:

1. Bump `version` in `package.json` and both `version` fields in `server.json`.
2. Merge to `main`. The workflow publishes to npm (with provenance), the [MCP Registry](https://registry.modelcontextprotocol.io) as `io.github.kisasa/populi-mcp`, and creates a GitHub release.

npm authentication uses [trusted publishing](https://docs.npmjs.com/trusted-publishers) if configured for this repo, otherwise the `NPM_TOKEN` repository secret.

## License

MIT. Not affiliated with Populi. "Populi" is a trademark of its owner.
