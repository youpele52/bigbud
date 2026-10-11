import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { decodeInspectionHex, v2WindowsInspector } from "./SharedService.windows.ts";
import { selectV2SharedDatabase } from "./SharedService.storage.files.ts";

/** OS file IDs remain strings throughout: a Windows volume/file ID must not be rounded by JS. */
export function decodeV2WindowsProcess(fields: readonly string[]) {
  if (fields.length !== 3 || !/^[0-9a-f]{16}$/.test(fields[0]!))
    throw new Error("Invalid process identity.");
  const binaryPath = decodeInspectionHex(fields[1]!);
  if (!path.win32.isAbsolute(binaryPath)) throw new Error("Invalid executable identity.");
  const files = new Map<string, string>();
  const owned = new Set<string>();
  const rows = fields[2] ? fields[2].split(";") : [];
  if (rows.length > 4096) throw new Error("Native file bound exceeded.");
  for (const row of rows) {
    const [encoded, identity, owner, extra] = row.split(",");
    if (
      !encoded ||
      extra !== undefined ||
      !identity ||
      !/^[01]$/.test(owner ?? "") ||
      !/^[0-9a-f]{16}:[0-9a-f]{32}$/.test(identity)
    )
      throw new Error("Invalid native file identity.");
    const name = decodeInspectionHex(encoded);
    if (
      !path.win32.isAbsolute(name) ||
      name.includes("\0") ||
      (files.has(name) && files.get(name) !== identity)
    )
      throw new Error("Invalid native file path.");
    files.set(name, identity);
    if (owner === "1") owned.add(name);
  }
  return { binaryPath, creation: fields[0]!, files, owned };
}

export async function inspectV2WindowsStorage(pid: number) {
  const inspect = async () =>
    decodeV2WindowsProcess(await v2WindowsInspector.request(`PROCESS\t${pid}`));
  const before = await inspect();
  const selected = selectV2SharedDatabase([...before.files.keys()]);
  const identity = before.files.get(selected)!;
  if (!before.owned.has(selected)) throw new Error("Native database owner mismatch.");
  const databasePath = await realpath(selected);
  const after = await inspect();
  if (
    before.creation !== after.creation ||
    before.binaryPath !== after.binaryPath ||
    selectV2SharedDatabase([...after.files.keys()]) !== selected ||
    after.files.get(selected) !== identity ||
    !after.owned.has(selected)
  )
    throw new Error("Native storage/process changed.");
  return {
    databasePath,
    binaryPath: before.binaryPath,
    storageIdentity: createHash("sha256")
      .update(JSON.stringify(["opencodeV2-shared-windows-v1", identity]))
      .digest("hex"),
  };
}
