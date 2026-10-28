import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as Path from "node:path";

/**
 * Write via a sibling temporary file and rename, so readers (and the Driver)
 * never observe a partial file. The temporary file is removed on failure.
 */
export function writeFileAtomically(
  filePath: string,
  contents: string | Uint8Array,
  mode?: number,
): void {
  const temporaryPath = `${filePath}.${Crypto.randomUUID()}.tmp`;
  FS.mkdirSync(Path.dirname(filePath), { recursive: true });
  try {
    FS.writeFileSync(temporaryPath, contents, mode === undefined ? undefined : { mode });
    FS.renameSync(temporaryPath, filePath);
  } catch (error) {
    FS.rmSync(temporaryPath, { force: true });
    throw error;
  }
}
