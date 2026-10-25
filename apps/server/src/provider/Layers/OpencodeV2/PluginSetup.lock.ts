import { randomBytes, sign, verify } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import type { V2PluginSetupArtifact } from "./PluginSetup.record.ts";
import {
  readV2NativePluginFile,
  releaseV2OwnedPublicationLock,
  v2NativePluginDirectory,
  type V2PluginFileIdentity,
} from "./PluginSetup.fs.ts";
import type { V2PluginSetupAuthority } from "./PluginSetup.paths.ts";
import { captureV2OperationAuthority } from "./Client.guard.ts";
import { acquireV2WindowsPublicationLock } from "./PluginSetup.lock.windows.ts";
import type { V2WindowsFileIdentity } from "./NativeFiles.windows.ts";
import type { V2RegistrationFamily } from "./Orchestration.registration.ts";

const encoded = (root: string, issuer: string, pid: number, nonce: string) =>
  Buffer.from(JSON.stringify(["bigbud.thread.install.lock.v1", root, issuer, pid, nonce]));

/** Cross-process conflicts fail closed. A dead PID is not authority for pathname-based reclamation. */
export async function acquireV2PluginPublicationLock(
  directory: string,
  identity: V2PluginFileIdentity,
  root: string,
  artifact: Pick<V2PluginSetupArtifact, "issuer" | "privateKey" | "publicKey">,
  requested: V2PluginSetupAuthority,
  family: V2RegistrationFamily = "legacy",
) {
  const authority = captureV2OperationAuthority(requested);
  // Immutable profile slots share a directory, not a writer identity. Never inspect or
  // reclaim another slot's retained lock. Private record locks keep their historical name.
  if (!/^[a-f0-9]{64}$/.test(artifact.issuer))
    throw new Error("V2 publication lock issuer rejected.");
  const filename = path.join(
    directory,
    family === "scoped"
      ? `.bigbud-thread-tools-${artifact.issuer}.lock`
      : ".bigbud-thread-tools-managed.lock",
  );
  const nonce = randomBytes(16).toString("hex");
  const content = JSON.stringify({
    root,
    issuer: artifact.issuer,
    pid: process.pid,
    nonce,
    signature: sign(
      null,
      encoded(root, artifact.issuer, process.pid, nonce),
      artifact.privateKey,
    ).toString("base64url"),
  });
  if (process.platform === "win32")
    return acquireV2WindowsPublicationLock(
      filename,
      content,
      identity as V2WindowsFileIdentity,
      authority,
    );
  for (let attempt = 0; attempt < 2; attempt++) {
    await v2NativePluginDirectory(directory, identity);
    authority.assertCurrent();
    authority.signal.throwIfAborted();
    let handle;
    try {
      handle = await open(
        filename,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      const old = await readV2NativePluginFile(filename, true, 16384);
      if (!old) continue;
      const owner = JSON.parse(old.content) as {
        root: string;
        issuer: string;
        pid: number;
        nonce: string;
        signature: string;
      };
      if (
        Object.keys(owner).toSorted().join() !== "issuer,nonce,pid,root,signature" ||
        owner.root !== root ||
        owner.issuer !== artifact.issuer ||
        !Number.isSafeInteger(owner.pid) ||
        owner.pid < 1 ||
        !/^[a-f0-9]{32}$/.test(owner.nonce) ||
        !verify(
          null,
          encoded(owner.root, owner.issuer, owner.pid, owner.nonce),
          artifact.publicKey,
          Buffer.from(owner.signature, "base64url"),
        )
      )
        // oxlint-disable-next-line preserve-caught-error -- Raw fs/lock causes may retain private paths; the message is the contract.
        throw new Error(
          "V2 required-plugin publication lock is foreign/invalid; existing evidence preserved.",
        );
      let exited = false;
      try {
        process.kill(owner.pid, 0);
      } catch (cause) {
        exited = cause instanceof Error && "code" in cause && cause.code === "ESRCH";
      }
      if (!exited)
        // oxlint-disable-next-line preserve-caught-error -- Raw fs/lock causes may retain private paths; the message is the contract.
        throw new Error(
          "V2 required-plugin publication is busy or its app owner is unconfirmed; retry without replacing files.",
        );
      authority.assertCurrent();
      authority.signal.throwIfAborted();
      // oxlint-disable-next-line preserve-caught-error -- Raw fs/lock causes may retain private paths; the message is the contract.
      throw new Error(
        "V2 publication-lock-remediation-required: the signed exited-owner lock is retained. Automatic reclamation cannot conditionally unlink an inode; arrange independently safe manual remediation without clearing history or uncertain records.",
      );
    }
    const created = await handle.stat();
    try {
      await v2NativePluginDirectory(directory, identity);
      authority.assertCurrent();
      authority.signal.throwIfAborted();
      await handle.writeFile(content);
      authority.assertCurrent();
      authority.signal.throwIfAborted();
      await handle.sync();
      authority.assertCurrent();
    } catch (error) {
      await handle.close();
      // A lost fence after an issued write leaves exact signed/partial lock evidence.
      // Never free a possibly unfinished writer by pretending timeout means prestart.
      let current = true;
      try {
        authority.assertCurrent();
      } catch {
        current = false;
      }
      if (current) await releaseV2OwnedPublicationLock(filename, created);
      throw error;
    }
    await handle.close();
    let releasing: Promise<void> | undefined;
    return () =>
      (releasing ??= (async () => {
        const current = await readV2NativePluginFile(filename, true, 16384);
        if (
          !current ||
          current.content !== content ||
          current.identity.dev !== created.dev ||
          current.identity.ino !== created.ino
        )
          throw new Error("V2 required-plugin publication lock successor preserved.");
        await releaseV2OwnedPublicationLock(filename, created);
      })());
  }
  throw new Error("V2 required-plugin publication lock could not be acquired safely.");
}
