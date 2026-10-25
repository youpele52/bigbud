import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { v2ThreadPrivateDirectory } from "./Orchestration.storage.ts";

/** Flush namespace entries as well as contents before granting native execution. */
export async function syncV2FamilyDirectory(directory: string) {
  await v2ThreadPrivateDirectory(directory);
  const handle = await open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
