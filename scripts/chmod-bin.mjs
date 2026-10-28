import { chmodSync } from "node:fs";

// npm sets the bit on install, but a local `npm link` / `node dist/index.js` shebang run needs it too.
try {
  chmodSync(new URL("../dist/index.js", import.meta.url), 0o755);
} catch {
  // not fatal on filesystems without POSIX modes
}
