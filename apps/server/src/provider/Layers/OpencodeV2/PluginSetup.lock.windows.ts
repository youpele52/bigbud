import {
  windowsCreate,
  windowsRead,
  windowsRemove,
  type V2WindowsFileIdentity,
} from "./NativeFiles.windows.ts";
import type { V2OperationAuthority } from "./Client.guard.ts";

/** Exclusive signed writer acquisition; no PID-based reclamation or ACL repairs on Windows. */
export async function acquireV2WindowsPublicationLock(
  filename: string,
  content: string,
  parent: V2WindowsFileIdentity,
  authority: V2OperationAuthority,
) {
  const owned = await windowsCreate(filename, content, authority.assertCurrent, parent).catch(
    (error) => {
      if (error instanceof Error && "code" in error && error.code === "EEXIST")
        throw new Error(
          "V2 required-plugin publication lock exists; foreign/unfinished ownership evidence retained without reclamation.",
        );
      throw error;
    },
  );
  let releasing: Promise<void> | undefined;
  return () =>
    (releasing ??= (async () => {
      const current = await windowsRead(filename, true);
      if (
        current.content !== owned.content ||
        current.identity.dev !== owned.identity.dev ||
        current.identity.ino !== owned.identity.ino
      )
        throw new Error("V2 required-plugin publication lock successor preserved.");
      // Exact-owned physical finalization remains possible after its execution permit expired.
      await windowsRemove(filename, owned, () => {});
    })());
}
