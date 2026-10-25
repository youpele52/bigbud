import { constants } from "node:fs";
import { open, realpath, lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

/** Portable fixed-fixture verifier, also embedded in the legacy SSH test program. It never
 * grants retail execution: only these exact pure Node HTTP fixture bytes can be returned. */
export async function verifyV2SyntheticSource(binary, profile) {
  const root = path.dirname(binary);
  const parent = await lstat(root);
  if (
    !parent.isDirectory() ||
    parent.uid !== process.getuid?.() ||
    (parent.mode & 0o077) !== 0 ||
    (await realpath(root)) !== root ||
    (root !== profile && path.dirname(profile) !== root)
  )
    throw new Error("V2 synthetic executable root is not canonical/private/owned.");
  const handle = await open(
    binary,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o222) !== 0 ||
      info.size > 32768 ||
      (await realpath(binary)) !== binary
    )
      throw new Error("V2 synthetic executable image is not immutable/owned.");
    const source = await handle.readFile();
    const after = await handle.stat(),
      named = await lstat(binary);
    if (
      info.dev !== named.dev ||
      info.ino !== named.ino ||
      info.ctimeMs !== after.ctimeMs ||
      info.size !== source.length ||
      createHash("sha256").update(source).digest("hex") !==
        "c8dc8a497b4f0fc76d0974d2eacde6be7df6a65a70a4ee0be734c6dbbdc5954e"
    )
      throw new Error("V2 synthetic fixture source changed; retail execution is not authorized.");
    return { executable: process.execPath, prefix: [binary] };
  } finally {
    await handle.close();
  }
}
