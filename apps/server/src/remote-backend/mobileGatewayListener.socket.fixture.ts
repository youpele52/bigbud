/** Focused actual Unix-socket regression; disposable state only, no backend or provider. */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import net from "node:net";
import { join } from "node:path";
import { prepareRemoteMobileSocket } from "./mobileSocket.ts";

const listen = (path: string) =>
  new Promise<net.Server>((resolve, reject) => {
    const server = net.createServer((socket) => socket.end());
    server.once("error", reject);
    server.listen(path, () => resolve(server));
  });
const close = (server: net.Server) =>
  new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
const held = async () => {};
export async function runMobileListenerSocketRegression() {
  const root = await fs.realpath(await fs.mkdtemp("/tmp/bb-new-mobile-sock-"));
  const path = join(root, "remote-mobile.sock");
  try {
    const stale = await listen(path);
    await fs.rename(path, path + ".stale");
    await close(stale);
    await fs.rename(path + ".stale", path);
    const before = await fs.lstat(path);
    await assert.rejects(
      prepareRemoteMobileSocket(root, held, { existing: "refuse-existing" }),
      /preexisting/,
    );
    assert.equal((await fs.lstat(path)).ino, before.ino);
    // Existing recovery callers retain their explicit established behavior.
    await prepareRemoteMobileSocket(root, held);
    await assert.rejects(fs.lstat(path), { code: "ENOENT" });

    const prepared = await prepareRemoteMobileSocket(root, held, { existing: "refuse-existing" });
    const foreign = await listen(path),
      foreignIdentity = await fs.lstat(path);
    const owned = await listen(prepared.bindPath);
    try {
      await assert.rejects(prepared.seal(), { code: "EEXIST" });
      await prepared.release();
      assert.equal((await fs.lstat(path)).ino, foreignIdentity.ino);
    } finally {
      await close(owned);
      // libuv's private bind cleanup must not unlink a later stable endpoint.
      assert.equal((await fs.lstat(path)).ino, foreignIdentity.ino);
      await close(foreign);
    }
    console.log(
      JSON.stringify({
        strictStalePreserved: true,
        legacyRecoveryRetained: true,
        lateForeignPublicationPreserved: true,
      }),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
if (import.meta.main) await runMobileListenerSocketRegression();
