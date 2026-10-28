import { constants } from "node:fs";
import { mkdir, open, readFile, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { PopuliError, type UploadFile } from "./client.js";

/** Safety cap: reading more than this into memory for an upload is almost certainly a mistake. */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

const TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".csv": "text/csv",
  ".txt": "text/plain",
  ".json": "application/json",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".zip": "application/zip",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
};

export function contentTypeFor(filename: string): string {
  return TYPES[extname(filename).toLowerCase()] ?? "application/octet-stream";
}

function extensionFor(contentType: string): string {
  const type = contentType.split(";")[0]!.trim().toLowerCase();
  // first match wins, so .jpg beats .jpeg
  return Object.entries(TYPES).find(([, t]) => t === type)?.[0] ?? (type.startsWith("text/") ? ".txt" : ".bin");
}

/** A file name that cannot escape a directory or upset a file system. */
export function safeName(name: string): string {
  const cleaned = basename(name.replace(/\\/g, "/"))
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f<>:"|?*]/g, "_")
    .replace(/^\.+/, "_")
    .trim();
  return (cleaned || "file").slice(0, 150);
}

/**
 * Resolves a caller-supplied path to a file inside `root`, or refuses. Relative paths are taken
 * relative to `root`. Symlinks are followed before the check, so a link inside the folder that
 * points outside it is refused too.
 */
export async function resolveInside(root: string, input: string): Promise<string> {
  const rootAbs = resolve(root);
  const target = resolve(rootAbs, input);
  const inside = (base: string, p: string) => {
    const rel = relative(base, p);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) && !rel.split(sep).includes("..");
  };
  if (!inside(rootAbs, target)) {
    throw new PopuliError(
      `"${input}" is outside the files folder (${rootAbs}). Put the file there, or set POPULI_FILES_DIR to a folder that contains it.`,
    );
  }
  let real: string;
  try {
    real = await realpath(target);
  } catch {
    throw new PopuliError(`No such file: ${target}`);
  }
  const realRoot = await realpath(rootAbs).catch(() => rootAbs);
  if (!inside(realRoot, real)) {
    throw new PopuliError(`"${input}" resolves outside the files folder (${rootAbs}).`);
  }
  return real;
}

export interface UploadSpec {
  /** A file inside the files folder (relative to it, or absolute within it). */
  path?: string;
  /** Alternative to `path`: the file contents, base64-encoded. */
  content_base64?: string;
  filename?: string;
  content_type?: string;
  /** Form field name. Populi's upload routes use `file`. */
  field?: string;
}

export async function readUpload(root: string, spec: UploadSpec): Promise<UploadFile> {
  if (!!spec.path === !!spec.content_base64) {
    throw new PopuliError("Each file needs exactly one of `path` or `content_base64`.");
  }
  let data: Uint8Array;
  let filename: string;
  if (spec.path) {
    const full = await resolveInside(root, spec.path);
    const info = await stat(full);
    if (!info.isFile()) throw new PopuliError(`${spec.path} is not a file.`);
    if (info.size > MAX_UPLOAD_BYTES) throw new PopuliError(`${spec.path} is larger than the 100 MB upload cap this server allows.`);
    data = await readFile(full);
    filename = safeName(spec.filename ?? basename(full));
  } else {
    const b64 = spec.content_base64!;
    // 4 base64 characters carry 3 bytes
    if ((b64.length * 3) / 4 > MAX_UPLOAD_BYTES) throw new PopuliError("File content is larger than the 100 MB upload cap this server allows.");
    data = Buffer.from(b64, "base64");
    filename = safeName(spec.filename ?? "upload.bin");
  }
  return {
    field: spec.field?.trim() || "file",
    filename,
    contentType: spec.content_type?.trim() || contentTypeFor(filename),
    data,
  };
}

/**
 * Writes a download into `root` without ever overwriting: an existing name gets `-1`, `-2`, ...
 * `name` is the model's choice and `filename` is what Populi suggested; both are sanitised.
 */
export async function saveDownload(
  root: string,
  opts: { name?: string; filename?: string; contentType: string; data: Uint8Array | string },
): Promise<{ path: string; bytes: number }> {
  await mkdir(root, { recursive: true });
  const wanted = safeName(opts.name ?? opts.filename ?? `populi-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  const ext = extname(wanted);
  const stem = ext ? wanted.slice(0, -ext.length) : wanted;
  const finalExt = ext || extensionFor(opts.contentType);
  const bytes = typeof opts.data === "string" ? Buffer.from(opts.data, "utf8") : opts.data;

  for (let n = 0; n < 1000; n++) {
    const path = join(root, `${stem}${n ? `-${n}` : ""}${finalExt}`);
    try {
      // wx: fail if it exists, so two downloads can never clobber each other
      const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      try {
        await handle.writeFile(bytes);
      } finally {
        await handle.close();
      }
      return { path, bytes: bytes.byteLength };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  throw new PopuliError(`Could not find a free file name for ${wanted} in ${root}.`);
}
