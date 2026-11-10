import { ConfigError, normalizeBaseUrl, parseTimeout } from "../lib/config.js";

export interface HostedConfig {
  port: number;
  /** Secrets that seal and open tokens. The first seals; all open. */
  secrets: string[];
  /** Public https origin of this server (no trailing slash), or undefined to derive it from request headers. */
  publicUrl?: string;
  /** When set, every user connects to this instance and only supplies an API key. */
  baseUrl?: string;
  /** Hostname suffixes people may enter as their instance when `baseUrl` is not pinned. */
  allowedHosts: string[];
  /** Whether people may opt in to writes when they connect. */
  allowWrites: boolean;
  /** Where OAuth may send people back to after they connect: `scheme://host` (any port and path) or `scheme:`. */
  redirectRules: string[];
  timeoutMs: number;
}

export const DEFAULT_REDIRECT_RULES = [
  "https://claude.ai",
  "https://claude.com",
  "https://chatgpt.com",
  "https://chat.openai.com",
  "https://platform.openai.com",
  "http://localhost",
  "http://127.0.0.1",
  "cursor:",
  "vscode:",
  "vscode-insiders:",
];

export const DEFAULT_ALLOWED_HOSTS = ["populiweb.com", "populi.co"];

const TRUTHY = new Set(["1", "true", "yes", "on"]);

function list(raw: string | undefined, fallback: string[]): string[] {
  const items = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length ? items : fallback;
}

export function loadHostedConfig(env: NodeJS.ProcessEnv = process.env): HostedConfig {
  const secrets = [env.POPULI_MCP_SECRET, ...(env.POPULI_MCP_PREVIOUS_SECRETS ?? "").split(",")]
    .map((s) => s?.trim())
    .filter((s): s is string => !!s);
  if (!secrets.length) {
    throw new ConfigError(
      "Missing POPULI_MCP_SECRET: a random string of at least 32 characters that protects the tokens this server issues.\n" +
        "  Generate one with: openssl rand -base64 48",
    );
  }
  if (secrets.some((s) => s.length < 32)) {
    throw new ConfigError("POPULI_MCP_SECRET (and any previous secrets) must be at least 32 characters.");
  }

  const port = Number(env.PORT ?? "8080");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConfigError("PORT must be a number from 1 to 65535.");

  let publicUrl: string | undefined;
  if (env.POPULI_MCP_PUBLIC_URL?.trim()) {
    let url: URL;
    try {
      url = new URL(env.POPULI_MCP_PUBLIC_URL.trim());
    } catch {
      throw new ConfigError(`POPULI_MCP_PUBLIC_URL is not a valid URL: "${env.POPULI_MCP_PUBLIC_URL}".`);
    }
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
      throw new ConfigError("POPULI_MCP_PUBLIC_URL must use https://.");
    }
    publicUrl = url.origin;
  }

  return {
    port,
    secrets,
    publicUrl,
    baseUrl: env.POPULI_BASE_URL?.trim() ? normalizeBaseUrl(env.POPULI_BASE_URL) : undefined,
    allowedHosts: list(env.POPULI_ALLOWED_HOSTS, DEFAULT_ALLOWED_HOSTS).map((h) => h.toLowerCase()),
    allowWrites: TRUTHY.has((env.POPULI_ALLOW_WRITES ?? "").trim().toLowerCase()),
    redirectRules: list(env.POPULI_ALLOWED_REDIRECTS, DEFAULT_REDIRECT_RULES),
    timeoutMs: parseTimeout(env.POPULI_TIMEOUT_MS),
  };
}

/** True when `host` is one of the suffixes or a subdomain of one. */
export function hostAllowed(host: string, suffixes: string[]): boolean {
  const h = host.toLowerCase();
  return suffixes.some((s) => h === s || h.endsWith(`.${s}`));
}

/**
 * Structural check, not a string prefix match: the redirect's scheme and exact hostname must match a
 * rule, and it may not carry credentials. `http://localhost:1@evil.com/` fails because its host is evil.com.
 */
export function redirectAllowed(uri: string, rules: string[]): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.username || url.password || url.hash) return false;
  return rules.some((rule) => {
    if (rule.endsWith(":")) return url.protocol === rule;
    try {
      const r = new URL(rule);
      return url.protocol === r.protocol && url.hostname === r.hostname;
    } catch {
      return false;
    }
  });
}
