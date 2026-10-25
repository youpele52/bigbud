import path from "node:path";
import {
  v2PublicationFilename,
  v2PluginContentHash,
  type V2PluginPublication,
} from "./PluginSetup.record.ts";
import {
  readV2NativePluginFile,
  v2NativePluginDirectory,
  type V2PluginFileIdentity,
} from "./PluginSetup.fs.ts";

/** Maintenance may adopt only one POSIX device transition, never a replacement object or changed bytes. */
export async function revalidateV2InstallationIdentity(
  old: V2PluginPublication,
  root: string,
  rootIdentity: V2PluginFileIdentity,
) {
  const pluginsIdentity = await v2NativePluginDirectory(path.join(root, "plugins"));
  const entry = await readV2NativePluginFile(
    path.join(root, "plugins", v2PublicationFilename(old)),
    true,
    16384,
  );
  if (
    !entry ||
    !old.nextIdentity ||
    entry.content !== old.next.content ||
    v2PluginContentHash(entry.content) !== old.next.hash ||
    old.rootIdentity.ino !== rootIdentity.ino ||
    old.pluginsIdentity.ino !== pluginsIdentity.ino ||
    old.nextIdentity.ino !== entry.identity.ino ||
    typeof rootIdentity.dev !== "number" ||
    typeof old.rootIdentity.dev !== "number" ||
    old.rootIdentity.dev === rootIdentity.dev ||
    old.pluginsIdentity.dev !== old.rootIdentity.dev ||
    old.nextIdentity.dev !== old.rootIdentity.dev ||
    pluginsIdentity.dev !== rootIdentity.dev ||
    entry.identity.dev !== rootIdentity.dev
  )
    throw new Error(
      "V2 reboot publication requires unchanged canonical inodes and exact bytes with one device-number transition.",
    );
  return { ...old, rootIdentity, pluginsIdentity, nextIdentity: entry.identity };
}
