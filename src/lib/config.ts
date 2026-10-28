import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface Config {
  /** Instance root plus `/api2`, no trailing slash. */
  baseUrl: string;
  apiKey: string;
  /** Whether the write tool is registered at all. Off unless POPULI_ALLOW_WRITES is truthy. */
  allowWrites: boolean;
  /** Populi issues `sk_sandbox_` keys that only work against sandbox instances. */
  sandbox: boolean;
  /**
   * The only directory the server reads uploads from and writes downloads to. A model-chosen path
   * is never trusted outside it, so a prompt-injected "upload ~/.ssh/id_rsa" has nothing to read.
   */
  filesDir: string;
  /** How long one Populi request may take. Data Slicer reports and big exports can be slow. */
  timeoutMs: number;
}

export class ConfigError extends Error {}

const TRUTHY = new Set(["1", "true", "yes", "on"]);

export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_TIMEOUT_MS = 600_000;

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

function parseTimeout(raw: string | undefined): number {
  if (!raw?.trim()) return DEFAULT_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1000 || n > MAX_TIMEOUT_MS) {
    throw new ConfigError(`POPULI_TIMEOUT_MS must be a whole number of milliseconds between 1000 and ${MAX_TIMEOUT_MS}.`);
  }
  return n;
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
    filesDir: env.POPULI_FILES_DIR?.trim() ? resolve(env.POPULI_FILES_DIR.trim()) : join(homedir(), "populi-mcp-files"),
    timeoutMs: parseTimeout(env.POPULI_TIMEOUT_MS),
  };
}
