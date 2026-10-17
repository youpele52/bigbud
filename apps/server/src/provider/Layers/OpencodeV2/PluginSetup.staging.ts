import { constants } from "node:fs";
import { open, rename, link } from "node:fs/promises";
import { v2NativePluginDirectory, type V2PluginFileIdentity } from "./PluginSetup.fs.ts";
import type { V2PluginSetupAuthority } from "./PluginSetup.paths.ts";
import {
  windowsCreate,
  windowsPublish,
  windowsFileHash,
  type V2WindowsFileIdentity,
} from "./NativeFiles.windows.ts";

export type V2PluginStaging = { readonly path: string } & V2PluginFileIdentity;
type Entry = { readonly content: string; readonly identity: V2PluginFileIdentity };

/** Staging tracks exact owned identity as soon as creation acknowledges; failed unknown creates remain evidence. */
export async function stageV2NativePlugin(
  temporary: string,
  content: string,
  plugins: { directory: string; identity: V2PluginFileIdentity },
  authority: V2PluginSetupAuthority,
  track: (value: V2PluginStaging) => void,
) {
  const assert = () => {
    authority.assertCurrent();
    authority.signal.throwIfAborted();
  };
  if (process.platform === "win32") {
    const file = await windowsCreate(
      temporary,
      content,
      assert,
      plugins.identity as V2WindowsFileIdentity,
    );
    track({ path: temporary, ...file.identity });
    return;
  }
  const handle = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const info = await handle.stat();
    track({ path: temporary, dev: info.dev, ino: info.ino });
    await v2NativePluginDirectory(plugins.directory, plugins.identity);
    assert();
    await handle.writeFile(content);
    assert();
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** The final fence executes at actual issuance, including after the Windows helper's bounded queue. */
export async function commitV2NativePlugin(
  temporary: string,
  filename: string,
  source: Entry,
  prior: Entry | undefined,
  parent: V2PluginFileIdentity,
  authority: V2PluginSetupAuthority,
) {
  const issue = () => {
    authority.assertCurrent();
    authority.signal.throwIfAborted();
    authority.publication?.assertGate();
    authority.publication?.mutationIssued?.();
  };
  if (process.platform === "win32") {
    const native = (entry: Entry) => ({
      ...entry,
      identity: entry.identity as V2WindowsFileIdentity,
      hash: windowsFileHash(entry.content),
    });
    await windowsPublish(
      temporary,
      filename,
      native(source),
      prior ? native(prior) : undefined,
      parent as V2WindowsFileIdentity,
      issue,
    );
    return;
  }
  issue();
  if (prior) await rename(temporary, filename);
  else await link(temporary, filename);
}

export async function finishV2NativePluginDirectory(
  directory: string,
  identity: V2PluginFileIdentity,
) {
  if (process.platform === "win32") {
    // The native commit already performed FlushFileBuffers + same-volume MOVEFILE_WRITE_THROUGH.
    // Windows directory FlushFileBuffers is not a substitute for that publication contract.
    await v2NativePluginDirectory(directory, identity);
    return;
  }
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
