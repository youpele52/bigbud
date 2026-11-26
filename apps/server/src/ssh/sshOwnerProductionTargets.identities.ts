import { lstat } from "node:fs/promises";
import path from "node:path";

/**
 * U17 ("like the old path"): OpenSSH's default identities when a host sets no `IdentityFile`,
 * in the order of OpenSSH 10.5 (`ssh_config(5)`). Mirrors the owner's
 * `config/identities.rs`: only a key that exists and passes the private-key rule (a regular
 * file, not a link, owned by this account, readable by no one else, 1 byte to 64 KiB) is used,
 * as OpenSSH skips an unprotected key.
 *
 * @module sshOwnerProductionTargets.identities
 */
export const OPENSSH_DEFAULT_IDENTITIES = [
  "id_rsa",
  "id_ecdsa",
  "id_ecdsa_sk",
  "id_ed25519",
  "id_ed25519_sk",
  "id_mldsa44_ed25519",
] as const;

const MAX_IDENTITY_BYTES = 64 * 1024;

/** The first usable default key under `<home>/.ssh`, or `undefined`. */
export async function firstDefaultIdentity(home: string): Promise<string | undefined> {
  const uid = process.getuid?.();
  for (const name of OPENSSH_DEFAULT_IDENTITIES) {
    const file = path.join(home, ".ssh", name);
    const info = await lstat(file).catch(() => undefined);
    if (
      info?.isFile() &&
      (uid === undefined || info.uid === uid) &&
      info.nlink === 1 &&
      (info.mode & 0o077) === 0 &&
      (info.mode & 0o400) !== 0 &&
      info.size > 0 &&
      info.size <= MAX_IDENTITY_BYTES
    )
      return file;
  }
  return undefined;
}
