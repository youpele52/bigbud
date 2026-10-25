import { randomBytes } from "node:crypto";
import path from "node:path";
import {
  windowsCreate,
  windowsDirectory,
  windowsPublish,
  windowsRead,
} from "./NativeFiles.windows.ts";
import type { V2OperationAuthority } from "./Client.guard.ts";

/** The caller verifies signatures/revisions; native publication compares the exact observed identity and bytes. */
export async function publishV2WindowsRecord(
  filename: string,
  before: unknown,
  content: string,
  authority: V2OperationAuthority,
) {
  const parent = await windowsDirectory(path.dirname(filename), true);
  const previous = before === undefined ? undefined : await windowsRead(filename, true);
  if (previous && JSON.stringify(JSON.parse(previous.content)) !== JSON.stringify(before))
    throw new Error("V2 thread-tools record successor preserved.");
  const temporary = `${filename}.${randomBytes(16).toString("hex")}`;
  const staged = await windowsCreate(temporary, content, authority.assertCurrent, parent);
  // Failure retains staging; neither a lost acknowledgement nor a timeout authorizes replay/repair.
  await windowsPublish(temporary, filename, staged, previous, parent, authority.assertCurrent);
}
