import { constants } from "node:fs";
import { access, lstat, readlink, realpath } from "node:fs/promises";
import path from "node:path";

export const linuxPickerLoopback = "127.0.0.1";
export type LinuxPickerAddressFamily = "inet" | "inet6";

export function linuxPickerAddress(family: LinuxPickerAddressFamily) {
  return family === "inet6" ? "::1" : linuxPickerLoopback;
}

// A fixed port is safe because each launch gets its own network namespace.
export const linuxPickerPort = 22222;
export const linuxPickerUser = "picker";
export const linuxPickerTools = {
  sandbox: "/usr/bin/bwrap",
  ssh: "/usr/bin/ssh",
  sshd: "/usr/sbin/sshd",
  keygen: "/usr/bin/ssh-keygen",
  keyscan: "/usr/bin/ssh-keyscan",
};

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

const systemAwk = "/usr/bin/awk";
const alternativesAwk = "/etc/alternatives/awk";
type PickerAwk = "/usr/bin/mawk" | "/usr/bin/gawk";

/** Debian awk is mediated by alternatives. Expose only the verified executable at that hop. */
export async function linuxPickerAwkAlternative(): Promise<PickerAwk | undefined> {
  if (!(await lstat(systemAwk)).isSymbolicLink()) return undefined;
  const next = path.resolve(path.dirname(systemAwk), await readlink(systemAwk));
  if (next !== alternativesAwk) return undefined;
  const executable = await realpath(alternativesAwk);
  if (executable !== "/usr/bin/mawk" && executable !== "/usr/bin/gawk")
    throw new Error("Unsupported Linux picker awk alternative.");
  const info = await lstat(executable);
  // In the outer rootless browser namespace, guest root is mapped to the overflow UID.
  if (!info.isFile() || info.uid === process.getuid?.() || (info.mode & 0o6022) !== 0)
    throw new Error("Expected a regular system Linux picker awk executable.");
  await access(executable, constants.X_OK);
  return executable;
}

export function linuxPickerSandboxArgs(
  root: string,
  uid: number,
  gid: number,
  syntheticPassword = false,
  awkAlternative?: PickerAwk,
) {
  if (!/^\/tmp\/bigbud-picker-linux-[a-zA-Z0-9]+$/.test(root) || !privateIds(uid, gid)) {
    throw new Error("Expected a private Linux picker path and a non-root user and group.");
  }
  return [
    "--unshare-user",
    "--uid",
    String(uid),
    "--gid",
    String(gid),
    "--unshare-pid",
    "--unshare-net",
    "--unshare-ipc",
    "--unshare-uts",
    "--hostname",
    "bigbud-picker",
    "--disable-userns",
    "--cap-drop",
    "ALL",
    "--new-session",
    "--die-with-parent",
    "--clearenv",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--tmpfs",
    "/tmp",
    "--dir",
    "/run/sshd",
    "--dir",
    "/var/empty",
    // Mount runtime tooling, not the host root, /etc, /run, /tmp, or any user home.
    "--ro-bind",
    "/usr/bin",
    "/usr/bin",
    "--ro-bind",
    "/bin",
    "/bin",
    "--ro-bind",
    "/usr/lib",
    "/usr/lib",
    ...["/lib", "/lib64", "/usr/lib64", "/usr/libexec"].flatMap((dir) => [
      "--ro-bind-try",
      dir,
      dir,
    ]),
    "--ro-bind",
    linuxPickerTools.sshd,
    linuxPickerTools.sshd,
    ...(awkAlternative ? ["--ro-bind", awkAlternative, alternativesAwk] : []),
    ...["passwd", "group", "nsswitch.conf", ...(syntheticPassword ? ["shadow"] : [])].flatMap(
      (name) => ["--ro-bind", path.join(root, name), `/etc/${name}`],
    ),
    "--bind",
    root,
    root,
    "--chdir",
    root,
    "--setenv",
    "HOME",
    path.join(root, "home"),
    "--setenv",
    "TMPDIR",
    "/tmp",
    "--setenv",
    "PATH",
    "/usr/bin:/bin",
    "--setenv",
    "LC_ALL",
    "C",
    "--setenv",
    "BIGBUD_SSH_OWNER_PICKER_PROOF",
    "1",
  ];
}

export function privateIds(uid: number, gid: number) {
  return Number.isSafeInteger(uid) && uid > 0 && Number.isSafeInteger(gid) && gid > 0;
}

export function linuxPickerReadOnlyAncestors(syntheticPassword: boolean) {
  // Freeze the system ancestors after all binds; the fixture's child bind stays writable.
  return [...(syntheticPassword ? ["--remount-ro", "/tmp"] : []), "--remount-ro", "/"];
}

export function renderLinuxPickerOwnerLauncher(
  sandboxArgs: readonly string[],
  root: string,
  syntheticPassword = false,
) {
  const entry = path.join(root, "start-daemon");
  const owner = path.join(root, "picker-owner");
  const args = [
    linuxPickerTools.sandbox,
    ...sandboxArgs,
    ...linuxPickerReadOnlyAncestors(syntheticPassword),
    "--setenv",
    "BIGBUD_SSH_OWNER_PICKER_RO_SYSTEM_TOOLS",
    "1",
    "--",
    "/bin/sh",
    entry,
    owner,
  ];
  return `#!/bin/sh\nexec ${args.map(shellQuote).join(" ")} "$@"\n`;
}

export function renderLinuxPickerSshdConfig(
  root: string,
  syntheticPassword = false,
  boundIdlePasswordMasterLifetime = false,
  addressFamily: LinuxPickerAddressFamily = "inet",
  hostKeyLines: readonly string[] = [`HostKey ${path.join(root, "host-key")}`],
  maxSessions = 10,
) {
  const authentication = syntheticPassword
    ? [
        "StrictModes yes",
        "AuthorizedKeysFile none",
        "AuthenticationMethods password",
        "PasswordAuthentication yes",
        "PubkeyAuthentication no",
        "PermitRootLogin no",
      ]
    : [
        // The only authorized-keys file lives under the private fixture root, not in HOME.
        `AuthorizedKeysFile ${path.join(root, "authorized_keys")}`,
        "StrictModes no",
        "AuthenticationMethods publickey",
        "PasswordAuthentication no",
      ];
  const address = addressFamily === "inet6" ? "[::1]" : linuxPickerLoopback;
  return [
    `AddressFamily ${addressFamily}`,
    `ListenAddress ${address}:${linuxPickerPort}`,
    ...hostKeyLines,
    `AllowUsers ${linuxPickerUser}`,
    "PidFile none",
    "LogLevel VERBOSE",
    "UseDNS no",
    "UsePAM no",
    ...authentication,
    "KbdInteractiveAuthentication no",
    `MaxSessions ${maxSessions}`,
    "PermitUserEnvironment no",
    "PermitUserRC no",
    "DisableForwarding yes",
    ...(syntheticPassword && boundIdlePasswordMasterLifetime ? ["UnusedConnectionTimeout 5s"] : []),
    "PermitTTY no",
    "",
  ].join("\n");
}

/** Keep sshd and the client in the same private network and PID namespaces. */
export const linuxPickerPasswordDaemonLog = "password-sshd.log";
export const linuxPickerKeyDaemonLog = "key-sshd.log";

export function renderLinuxPickerDaemonEntrypoint(
  root: string,
  uid: number,
  gid: number,
  syntheticPassword = false,
  {
    addressFamily = "inet",
    observeKeyDaemon = false,
    outsideMaster = false,
  }: {
    readonly addressFamily?: LinuxPickerAddressFamily;
    readonly observeKeyDaemon?: boolean;
    /** A separate, test-owned master in this namespace that the owner must never use. */
    readonly outsideMaster?: boolean;
  } = {},
) {
  const config = shellQuote(path.join(root, "sshd_config"));
  const logName = syntheticPassword
    ? linuxPickerPasswordDaemonLog
    : observeKeyDaemon
      ? linuxPickerKeyDaemonLog
      : undefined;
  // Only opted-in fixture observers can see this log. Truncate it before spawn.
  const log = logName ? shellQuote(path.join(root, logName)) : "/tmp/picker-sshd.log";
  const ready = shellQuote(
    `Server listening on ${linuxPickerAddress(addressFamily)} port ${linuxPickerPort}.`,
  );
  return [
    "set -eu",
    "umask 077",
    `[ "$(id -u)" = ${uid} ] && [ "$(id -g)" = ${gid} ] || exit 1`,
    // FD3 is for the owner, never for the co-launched daemon or its sessions.
    `${linuxPickerTools.sshd} -D -e -f ${config} </dev/null >${log} 2>&1 3<&- &`,
    "daemon=$!",
    "attempt=0",
    `until grep -Fq -- ${ready} ${log}; do`,
    '  if ! kill -0 "$daemon" 2>/dev/null || [ "$attempt" -ge 50 ]; then',
    `    if [ -f ${log} ]; then tail -n 10 ${log} >&2; fi`,
    "    printf '%s\\n' 'Private Linux picker sshd did not bind.' >&2",
    "    exit 1",
    "  fi",
    "  attempt=$((attempt + 1))",
    "  sleep 0.1",
    "done",
    ...(outsideMaster ? renderOutsideMaster(root) : []),
    // Bubblewrap tears down the PID namespace (and sshd) when this process exits.
    'exec "$@"',
    "",
  ].join("\n");
}

function renderOutsideMaster(root: string) {
  const socket = shellQuote(path.join(root, "outside.sock"));
  const options = [
    "-F /dev/null -N -o ControlMaster=yes",
    `-o ControlPath=${socket} -o BatchMode=yes -o StrictHostKeyChecking=yes`,
    `-o UserKnownHostsFile=${shellQuote(path.join(root, "known_hosts"))}`,
    `-o IdentitiesOnly=yes -o IdentityAgent=none -i ${shellQuote(path.join(root, "identity"))}`,
    `-p ${linuxPickerPort} ${linuxPickerUser}@${linuxPickerLoopback}`,
  ].join(" ");
  return [
    // A preflight launch leaves a stale socket behind; never let it satisfy readiness.
    `rm -f ${socket}`,
    `${linuxPickerTools.ssh} ${options} </dev/null >/dev/null 2>&1 &`,
    "attempt=0",
    `until [ -S ${socket} ]; do`,
    '  [ "$attempt" -lt 50 ] || exit 1',
    "  attempt=$((attempt + 1))",
    "  sleep 0.1",
    "done",
  ];
}
