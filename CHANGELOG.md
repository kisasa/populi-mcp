# Changelog

## 0.4.0

Supports the MCP 2026-07-28 protocol, so current clients connect without a rejected first request.

- **2026-07-28 protocol.** Moved from `@modelcontextprotocol/sdk` 1.x to the v2 TypeScript SDK (`@modelcontextprotocol/server` 2.4). Clients on 2026-07-28 now get `server/discover` and stateless per-request calls. Before, the hosted server answered every new connection's first request with `400 Unsupported protocol version`, and the client then fell back to the older handshake.
- **Older clients unchanged.** Clients on 2025-11-25 and earlier still get the `initialize` handshake, on both the hosted server and stdio.
- **Hosted server.** Replies stay plain JSON, never a stream. The server now advertises `tools.listChanged: false`, since its tools never change mid-connection, and answers `subscriptions/listen` with an error straight away. A listen stream would otherwise hold a buffered host such as Lambda open until it times out.
- **Tools unchanged.** Names, descriptions, input schemas, annotations and results are the same. The one visible difference is that each input schema's `$schema` now names JSON Schema 2020-12 instead of draft-07, the dialect the MCP spec has used by default since 2025-11-25.
- **Local stdio** now starts through the SDK's `serveStdio`, which picks the protocol era per connection. Configuration and the files folder behave exactly as before.

## 0.3.0

Hosted mode (`--http`): Streamable HTTP with per-person OAuth sign-in, for Claude and ChatGPT connectors.

## 0.2.0

The whole API: file uploads and downloads (`populi_download`), no hard paging limits, configurable timeouts.

## 0.1.x

Initial releases: route catalog search and describe, reads, people lookup, opt-in writes.
