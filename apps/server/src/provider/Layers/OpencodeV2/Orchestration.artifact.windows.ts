import path from "node:path";
import { windowsMkdir, windowsCreate } from "./NativeFiles.windows.ts";
import { captureV2OperationAuthority } from "./Client.guard.ts";

/** Reserve one immutable directory, publish each flushed module exclusively, and write the manifest last. */
export async function publishV2WindowsArtifact(
  directory: string,
  contents: Readonly<Record<string, string>>,
  verify: () => Promise<void>,
) {
  const authority = captureV2OperationAuthority();
  try {
    await windowsMkdir(path.dirname(directory), path.basename(directory), authority.assertCurrent);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    await verify();
    return;
  }
  for (const [name, content] of Object.entries(contents))
    await windowsCreate(path.join(directory, name), content, authority.assertCurrent);
  await verify();
}
