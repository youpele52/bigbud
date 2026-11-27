import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";

/**
 * Owner artifact identity and bounded exit wait (v1.owner_shutdown.proto).
 *
 * The identity is SHA-256 over a domain tag, the canonical executable path and the
 * SHA-256 of the executable bytes; the owner measures the same value at its own
 * startup. A backend attaches only an owner whose identity equals the artifact it
 * would launch, so an owner from another install path or build is never adopted.
 *
 * @module sshOwnerProductionClient.identity
 */
const DOMAIN = Buffer.from("bigbud.ssh-owner.artifact.v1\0", "ascii");

/** Pure form of the identity, shared with the owner's Rust measurement. */
export function sshOwnerArtifactIdentity(canonicalPath: string, imageDigest: Uint8Array): Buffer {
  return createHash("sha256")
    .update(DOMAIN)
    .update(Buffer.from(canonicalPath))
    .update(Buffer.from([0]))
    .update(imageDigest)
    .digest();
}

/** Measures the artifact at `path` (resolved to its canonical path, as the owner does). */
export async function measureSshOwnerArtifactIdentity(path: string): Promise<Buffer> {
  const canonical = await realpath(path);
  const image = createHash("sha256");
  for await (const chunk of createReadStream(canonical)) image.update(chunk as Buffer);
  return sshOwnerArtifactIdentity(canonical, image.digest());
}

/** Bounded wait for a shut-down owner to remove its attach socket. */
export const SSH_OWNER_EXIT_WAIT_MS = 12_000;

/** Resolves `true` once the owner's attach socket is gone, `false` at the deadline. */
export async function waitForSshOwnerSocketGone(
  socketPath: string,
  deadlineMs: number = SSH_OWNER_EXIT_WAIT_MS,
): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const present = await lstat(socketPath).then(
      () => true,
      (cause: NodeJS.ErrnoException) => cause.code !== "ENOENT",
    );
    if (!present) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
