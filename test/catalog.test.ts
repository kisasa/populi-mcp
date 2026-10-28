import { beforeAll, describe, expect, it } from "vitest";
import { Catalog, describe as describeOp } from "../src/lib/catalog.js";

let catalog: Catalog;
beforeAll(() => {
  catalog = Catalog.load();
});

describe("bundled catalog", () => {
  it("covers the full API v2 surface with unique ids", () => {
    expect(catalog.ops.length).toBeGreaterThanOrEqual(690);
    expect(new Set(catalog.ops.map((o) => o.id)).size).toBe(catalog.ops.length);
  });

  it("finds routes by keyword", () => {
    const ids = catalog.search("application").map((o) => o.id);
    expect(ids.some((id) => id.startsWith("applications."))).toBe(true);
  });

  it("filters search by method", () => {
    const hits = catalog.search("people", { method: "DELETE" });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((o) => o.method === "DELETE")).toBe(true);
  });

  it("ranks the model a word names above models that merely contain it", () => {
    // 'application' is a substring of 'aidapplications', which sorts first alphabetically
    expect(catalog.search("application")[0]!.model).toBe("applications");
    expect(catalog.search("person")[0]!.model).toBe("people");
  });

  it("indexes filter and parameter names so extra words narrow the results", () => {
    const hits = catalog.search("application status", { limit: 5 });
    expect(hits[0]!.id).toBe("applications.index");
    expect(hits.slice(0, 3).every((o) => o.model === "applications")).toBe(true);
  });

  it("ranks an exact id first", () => {
    expect(catalog.search("people.create")[0]!.id).toBe("people.create");
  });

  it("matches concrete paths to documented routes", () => {
    expect(catalog.match("GET", "/people/24469940")?.id).toBe("people.show");
    expect(catalog.match("PUT", "/api2/people/1/emailaddresses/2")?.method).toBe("PUT");
    expect(catalog.match("GET", "/nonexistent/route")).toBeUndefined();
  });

  it("describes a route with required body fields and action parameters", () => {
    const text = describeOp(catalog.get("people.create")!);
    expect(text).toContain("POST /people");
    expect(text).toContain("first_name (required)");
    expect(text).toContain("`actions`");
  });
});
