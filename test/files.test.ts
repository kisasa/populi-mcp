import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PopuliError } from "../src/lib/client.js";
import { contentTypeFor, readUpload, resolveInside, safeName, saveDownload } from "../src/lib/files.js";
import { tempDir } from "./helpers.js";

describe("safeName", () => {
  it.each([
    ["report.pdf", "report.pdf"],
    ["../../etc/passwd", "passwd"],
    ["..\\..\\Windows\\system.ini", "system.ini"],
    ["a/b/c.csv", "c.csv"],
    [".hidden", "_hidden"],
    ['we<ir>d:"na|me?.txt', "we_ir_d__na_me_.txt"],
    ["", "file"],
    ["   ", "file"],
  ])("%j -> %j", (input, expected) => {
    expect(safeName(input)).toBe(expected);
  });

  it("caps very long names", () => {
    expect(safeName("x".repeat(500) + ".pdf").length).toBeLessThanOrEqual(150);
  });
});

describe("contentTypeFor", () => {
  it.each([
    ["a.PDF", "application/pdf"],
    ["a.jpeg", "image/jpeg"],
    ["a.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    ["a.unknown", "application/octet-stream"],
    ["noext", "application/octet-stream"],
  ])("%s -> %s", (name, type) => expect(contentTypeFor(name)).toBe(type));
});

describe("resolveInside", () => {
  it("accepts relative and absolute paths within the folder", async () => {
    const root = tempDir();
    writeFileSync(join(root, "a.txt"), "x");
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "sub", "b.txt"), "y");
    expect(await resolveInside(root, "a.txt")).toMatch(/a\.txt$/);
    expect(await resolveInside(root, "sub/b.txt")).toMatch(/b\.txt$/);
    expect(await resolveInside(root, join(root, "a.txt"))).toMatch(/a\.txt$/);
  });

  it.each(["../outside.txt", "sub/../../outside.txt", "/etc/passwd", "C:\\Windows\\win.ini", "..", "."])(
    "refuses %s",
    async (p) => {
      const root = tempDir();
      await expect(resolveInside(root, p)).rejects.toBeInstanceOf(PopuliError);
    },
  );

  it("says plainly when the file does not exist", async () => {
    await expect(resolveInside(tempDir(), "missing.pdf")).rejects.toThrow(/No such file/);
  });

  it("refuses a symlink that leaves the folder", async () => {
    const root = tempDir();
    const outside = tempDir();
    writeFileSync(join(outside, "secret.txt"), "secret");
    try {
      symlinkSync(join(outside, "secret.txt"), join(root, "link.txt"));
    } catch {
      return; // creating symlinks needs elevated rights on some Windows setups
    }
    await expect(resolveInside(root, "link.txt")).rejects.toThrow(/outside the files folder/);
  });
});

describe("readUpload", () => {
  it("reads a file from the folder and infers its type", async () => {
    const root = tempDir();
    writeFileSync(join(root, "photo.jpg"), Buffer.from([1, 2, 3]));
    const up = await readUpload(root, { path: "photo.jpg" });
    expect(up).toMatchObject({ field: "file", filename: "photo.jpg", contentType: "image/jpeg" });
    expect(Array.from(up.data)).toEqual([1, 2, 3]);
  });

  it("accepts base64 content with an explicit name, type and field", async () => {
    const up = await readUpload(tempDir(), {
      content_base64: Buffer.from("hello").toString("base64"),
      filename: "../note.txt",
      content_type: "text/plain",
      field: "attachment",
    });
    expect(up).toMatchObject({ field: "attachment", filename: "note.txt", contentType: "text/plain" });
    expect(Buffer.from(up.data).toString()).toBe("hello");
  });

  it("needs exactly one of path or content_base64", async () => {
    const root = tempDir();
    await expect(readUpload(root, {})).rejects.toThrow(/exactly one/);
    await expect(readUpload(root, { path: "a", content_base64: "AA==" })).rejects.toThrow(/exactly one/);
  });

  it("will not read outside the folder", async () => {
    await expect(readUpload(tempDir(), { path: "../../etc/passwd" })).rejects.toBeInstanceOf(PopuliError);
  });

  it("refuses a directory", async () => {
    const root = tempDir();
    mkdirSync(join(root, "d"));
    await expect(readUpload(root, { path: "d" })).rejects.toThrow(/not a file/);
  });
});

describe("saveDownload", () => {
  it("saves into the folder and creates it when missing", async () => {
    const root = join(tempDir(), "not", "yet", "there");
    const saved = await saveDownload(root, { name: "grades.csv", contentType: "text/csv", data: "a,b\n1,2" });
    expect(saved.path).toBe(join(root, "grades.csv"));
    expect(readFileSync(saved.path, "utf8")).toBe("a,b\n1,2");
    expect(saved.bytes).toBe(7);
  });

  it("never overwrites: a taken name gets a numeric suffix", async () => {
    const root = tempDir();
    const a = await saveDownload(root, { name: "t.pdf", contentType: "application/pdf", data: new Uint8Array([1]) });
    const b = await saveDownload(root, { name: "t.pdf", contentType: "application/pdf", data: new Uint8Array([2]) });
    const c = await saveDownload(root, { name: "t.pdf", contentType: "application/pdf", data: new Uint8Array([3]) });
    expect([a.path, b.path, c.path]).toEqual([join(root, "t.pdf"), join(root, "t-1.pdf"), join(root, "t-2.pdf")]);
    expect(Array.from(readFileSync(a.path))).toEqual([1]);
  });

  it("cannot be steered out of the folder by the requested or suggested name", async () => {
    const root = tempDir();
    const a = await saveDownload(root, { name: "../../evil.pdf", contentType: "application/pdf", data: "x" });
    const b = await saveDownload(root, { filename: "..\\..\\evil2.pdf", contentType: "application/pdf", data: "x" });
    expect(a.path).toBe(join(root, "evil.pdf"));
    expect(b.path).toBe(join(root, "evil2.pdf"));
  });

  it("prefers the requested name, then Populi's, then a timestamp, adding an extension from the type", async () => {
    const root = tempDir();
    expect((await saveDownload(root, { name: "mine", filename: "theirs.pdf", contentType: "application/pdf", data: "x" })).path).toBe(
      join(root, "mine.pdf"),
    );
    expect((await saveDownload(root, { filename: "theirs.xls", contentType: "application/vnd.ms-excel", data: "x" })).path).toBe(
      join(root, "theirs.xls"),
    );
    const generated = await saveDownload(root, { contentType: "application/pdf", data: "x" });
    expect(generated.path).toMatch(/populi-.*\.pdf$/);
  });
});
