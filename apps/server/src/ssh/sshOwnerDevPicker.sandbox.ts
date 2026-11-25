import { chmod, copyFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

interface SandboxInput {
  readonly root: string;
  readonly source: string;
  readonly existingClientPolicy: string;
  readonly attachmentSocket?: string | undefined;
  readonly guardedApplyProof?: boolean | undefined;
  readonly allowPty?: boolean | undefined;
  readonly allowPosixPickerMaster?: boolean | undefined;
  /** Connector fixture only: exact executables the owner may launch besides OpenSSH. */
  readonly connectorExec?: readonly string[] | undefined;
}

/** Use only with an owned macOS loopback fixture and its private directory. */
export async function installDevSshOwnerSandbox({
  root,
  source,
  existingClientPolicy,
  attachmentSocket,
  allowPty = false,
  guardedApplyProof = false,
  allowPosixPickerMaster = false,
  connectorExec = [],
}: SandboxInput) {
  if (
    connectorExec.length &&
    (!allowPosixPickerMaster || connectorExec.some((entry) => !/^\/[A-Za-z0-9/._-]+$/.test(entry)))
  )
    throw new Error("Connector executables need the isolated POSIX master fixture.");
  if (!/^\/private\/tmp\/[a-zA-Z0-9_-]+$/.test(root))
    throw new Error("Expected a private fixture path.");
  if (
    allowPosixPickerMaster &&
    (allowPty ||
      !root.startsWith("/private/tmp/bigbud-picker-sshd-") ||
      (attachmentSocket !== undefined && attachmentSocket !== path.join(root, "owner.sock")))
  )
    throw new Error("The POSIX master fixture must have an isolated picker sandbox.");
  // Seatbelt path regex does not reliably support counted repetition.
  const nonce = "[A-Za-z0-9]";
  const masterSocket = `#${JSON.stringify(`^${root}/bbcm-${nonce.repeat(12)}/s([.]${nonce.repeat(16)})?$`)}`;
  const binary = path.join(root, "picker-owner");
  const wrapper = path.join(root, "start-picker-owner");
  const policy = path.join(root, "picker-owner.sb");
  await copyFile(source, binary);
  await chmod(binary, 0o700);
  await writeFile(
    policy,
    [
      await readFile(existingClientPolicy, "utf8"),
      ...(attachmentSocket
        ? [
            `(allow network-bind network-inbound (local unix-socket (path-literal ${JSON.stringify(attachmentSocket)})))`,
          ]
        : []),
      ...(allowPosixPickerMaster
        ? [
            `(allow network-bind network-inbound (local unix-socket (path-regex ${masterSocket})))`,
            `(allow network-outbound (remote unix-socket (path-regex ${masterSocket})))`,
          ]
        : []),
      "(deny file-write*)",
      `(allow file-write* (subpath ${JSON.stringify(root)}) (literal "/dev/null"))`,
      ...(allowPty
        ? ['(allow file-write* (regex #"^/dev/(ptmx|ttys[0-9a-zA-Z]+|pty[0-9a-zA-Z]+)$"))']
        : []),
      "(deny process-exec)",
      `(allow process-exec (literal ${JSON.stringify(binary)}) (literal "/usr/bin/ssh") (literal "/usr/bin/ssh-keyscan") (literal "/usr/bin/ssh-keygen"))`,
      ...connectorExec.map((entry) => `(allow process-exec (literal ${JSON.stringify(entry)}))`),
    ].join("\n"),
  );
  // Fixture temp paths are created by mkdtemp below /private/tmp and contain no shell metacharacters.
  await writeFile(
    wrapper,
    `#!/bin/sh\n${guardedApplyProof ? "export BIGBUD_SSH_OWNER_GUARDED_WRITE_APPLY_PROOF=approved-disposable\n" : ""}exec /usr/bin/sandbox-exec -f '${policy}' '${binary}' "$@"\n`,
    {
      mode: 0o700,
    },
  );
  return wrapper;
}
