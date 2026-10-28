export interface Config {
  /** Instance root plus `/api2`, no trailing slash. */
  baseUrl: string;
  apiKey: string;
  /** Whether the write tool is registered at all. Off unless POPULI_ALLOW_WRITES is truthy. */
  allowWrites: boolean;
  /** Populi issues `sk_sandbox_` keys that only work against sandbox instances. */
  sandbox: boolean;
}

export class ConfigError extends Error {}

const TRUTHY = new Set(["1", "true", "yes", "on"]);

/**
 * Accepts the instance URL with or without `/api2`, so both
 * `https://school.populiweb.com` and `https://school.populiweb.com/api2` work.
 */
export function normalizeBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ConfigError(
      `POPULI_BASE_URL is not a valid URL: "${raw}". Expected something like https://yourschool.populiweb.com`,
    );
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new ConfigError("POPULI_BASE_URL must use https:// (the API key is sent as a bearer token).");
  }
  if (url.search || url.hash) {
    throw new ConfigError("POPULI_BASE_URL must not contain a query string or fragment.");
  }
  const path = url.pathname.replace(/\/+$/, "");
  const withApi = /\/api2$/.test(path) ? path : `${path}/api2`;
  return `${url.origin}${withApi}`;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const missing = ["POPULI_BASE_URL", "POPULI_API_KEY"].filter((k) => !env[k]?.trim());
  if (missing.length) {
    throw new ConfigError(
      `Missing required environment variable${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}.\n` +
        "  POPULI_BASE_URL  your instance, e.g. https://yourschool.populiweb.com\n" +
        "  POPULI_API_KEY   an API key token (Account & Settings > API > Keys in Populi)",
    );
  }
  const apiKey = env.POPULI_API_KEY!.trim();
  return {
    baseUrl: normalizeBaseUrl(env.POPULI_BASE_URL!),
    apiKey,
    allowWrites: TRUTHY.has((env.POPULI_ALLOW_WRITES ?? "").trim().toLowerCase()),
    sandbox: apiKey.startsWith("sk_sandbox_"),
  };
}
