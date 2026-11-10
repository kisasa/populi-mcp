import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";

/**
 * Stateless tokens: everything the server needs to remember (a registered client, an authorization
 * code, a person's Populi credentials) is sealed into the token itself with AES-256-GCM, so the
 * hosted server needs no database. The token type is bound in as authenticated data, so a refresh
 * token can't be passed off as an access token, and so on.
 */
export type TokenType = "client" | "code" | "access" | "refresh";

const PREFIX = "pm1.";

function keyFor(secret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, "populi-mcp", "token-key", 32));
}

export class TokenBox {
  private readonly keys: Buffer[];

  /** The first secret seals; every secret opens, so the secret can be rotated without logging everyone out. */
  constructor(secrets: string[]) {
    if (!secrets.length) throw new Error("TokenBox needs at least one secret.");
    this.keys = secrets.map(keyFor);
  }

  seal(type: TokenType, payload: Record<string, unknown>, ttlSeconds: number, now = Date.now()): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.keys[0]!, iv);
    cipher.setAAD(Buffer.from(type));
    const body = JSON.stringify({ ...payload, exp: Math.floor(now / 1000) + ttlSeconds });
    const ct = Buffer.concat([cipher.update(body, "utf8"), cipher.final()]);
    return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64url");
  }

  /** The payload, or undefined when the token is malformed, tampered with, the wrong type, or expired. */
  open<T extends Record<string, unknown>>(type: TokenType, token: string, now = Date.now()): (T & { exp: number }) | undefined {
    if (!token.startsWith(PREFIX)) return undefined;
    let raw: Buffer;
    try {
      raw = Buffer.from(token.slice(PREFIX.length), "base64url");
    } catch {
      return undefined;
    }
    if (raw.length < 12 + 16 + 2) return undefined;
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const ct = raw.subarray(28);
    for (const key of this.keys) {
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, iv);
        decipher.setAAD(Buffer.from(type));
        decipher.setAuthTag(tag);
        const body = Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
        const payload = JSON.parse(body) as T & { exp: number };
        if (typeof payload.exp !== "number" || payload.exp * 1000 <= now) return undefined;
        return payload;
      } catch {
        // wrong key or corrupted: try the next secret
      }
    }
    return undefined;
  }
}

/** RFC 7636 S256: base64url(sha256(verifier)). */
export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}
