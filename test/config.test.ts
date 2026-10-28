import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, normalizeBaseUrl } from "../src/lib/config.js";

describe("normalizeBaseUrl", () => {
  it.each([
    ["https://school.populiweb.com", "https://school.populiweb.com/api2"],
    ["https://school.populiweb.com/", "https://school.populiweb.com/api2"],
    ["https://school.populiweb.com/api2", "https://school.populiweb.com/api2"],
    ["https://school.populiweb.com/api2/", "https://school.populiweb.com/api2"],
    ["  https://tsri.demo.populi.co/api2  ", "https://tsri.demo.populi.co/api2"],
  ])("%s -> %s", (input, expected) => {
    expect(normalizeBaseUrl(input)).toBe(expected);
  });

  it("rejects plain http except for localhost", () => {
    expect(() => normalizeBaseUrl("http://school.populiweb.com")).toThrow(ConfigError);
    expect(normalizeBaseUrl("http://localhost:8080")).toBe("http://localhost:8080/api2");
  });

  it("rejects garbage and query strings", () => {
    expect(() => normalizeBaseUrl("school")).toThrow(ConfigError);
    expect(() => normalizeBaseUrl("https://school.populiweb.com/?x=1")).toThrow(ConfigError);
  });
});

describe("loadConfig", () => {
  const env = { POPULI_BASE_URL: "https://school.populiweb.com", POPULI_API_KEY: "sk_live_abc" };

  it("requires both variables and names the missing ones", () => {
    expect(() => loadConfig({})).toThrow(/POPULI_BASE_URL, POPULI_API_KEY/);
    expect(() => loadConfig({ POPULI_BASE_URL: "https://x.populiweb.com" })).toThrow(/POPULI_API_KEY/);
  });

  it("never echoes the key in an error", () => {
    expect(() => loadConfig({ POPULI_BASE_URL: "nope", POPULI_API_KEY: "sk_secret_value" })).toThrow(
      expect.not.objectContaining({ message: expect.stringContaining("sk_secret_value") }),
    );
  });

  it("is read-only by default and detects sandbox keys", () => {
    expect(loadConfig(env)).toMatchObject({ allowWrites: false, sandbox: false });
    expect(loadConfig({ ...env, POPULI_API_KEY: "sk_sandbox_abc" }).sandbox).toBe(true);
  });

  it.each(["1", "true", "TRUE", "yes"])("enables writes for POPULI_ALLOW_WRITES=%s", (v) => {
    expect(loadConfig({ ...env, POPULI_ALLOW_WRITES: v }).allowWrites).toBe(true);
  });

  it.each(["0", "false", "", "nope"])("keeps writes off for POPULI_ALLOW_WRITES=%j", (v) => {
    expect(loadConfig({ ...env, POPULI_ALLOW_WRITES: v }).allowWrites).toBe(false);
  });
});
