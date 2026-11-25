import { lstat, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Holds one armed public-key lookup inside the disposable sshd, so a real OpenSSH client is
 * mid-authentication. Uses the root-owned /bin/sh with a fixture script; no credential is held
 * and the gate opens on its own after eight seconds.
 */
export async function prepareAuthenticationGate(
  root: string,
  authorizedKeys: string,
  username: string,
) {
  const script = path.join(root, "auth-gate");
  const armed = path.join(root, "auth-gate-armed");
  const held = path.join(root, "auth-gate-held");
  const release = path.join(root, "auth-gate-release");
  await writeFile(
    script,
    [
      `if [ -f '${armed}' ] && /bin/mkdir '${held}' 2>/dev/null; then`,
      `  i=0; while [ ! -f '${release}' ] && [ "$i" -lt 80 ]; do /bin/sleep 0.1; i=$((i+1)); done`,
      "fi",
      `exec /bin/cat '${authorizedKeys}'`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  return {
    sshdConfig: [
      "AuthorizedKeysFile none",
      `AuthorizedKeysCommand /bin/sh ${script}`,
      `AuthorizedKeysCommandUser ${username}`,
    ],
    /** Hold the next authentication until release. */
    async arm() {
      await rm(held, { recursive: true, force: true });
      await rm(release, { force: true });
      await writeFile(armed, "");
    },
    async isHeld() {
      return (await lstat(held).catch(() => undefined))?.isDirectory() === true;
    },
    async release() {
      await writeFile(release, "");
      await rm(armed, { force: true });
    },
  };
}
