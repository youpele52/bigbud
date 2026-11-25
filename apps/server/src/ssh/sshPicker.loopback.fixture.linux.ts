import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { startHostKeyAgentGate } from "./sshPicker.loopback.fixture.linux.hostKeyGate.ts";

import {
  linuxPickerAddress,
  linuxPickerAwkAlternative,
  type LinuxPickerAddressFamily,
  linuxPickerKeyDaemonLog,
  linuxPickerPasswordDaemonLog,
  linuxPickerPort as port,
  linuxPickerReadOnlyAncestors,
  linuxPickerSandboxArgs,
  linuxPickerTools as tools,
  linuxPickerUser as user,
  privateIds,
  renderLinuxPickerDaemonEntrypoint,
  renderLinuxPickerOwnerLauncher,
  renderLinuxPickerSshdConfig,
} from "./sshPicker.loopback.fixture.linux.sandbox.ts";

const execute = promisify(execFile);
// SHA-512 crypt of the fixed S2-synthetic-owner-password. Never read the guest's shadow.
const syntheticPasswordHash =
  "$6$bigbudS2fixture$.PQtUSnom5EZmAUV9vIQ4mqv4DXwUJX6kDaakngZ9PZR/9EWJelEfmkrN7BLSdQhli2Nq1Nt006xp3WLbXX.g1";
// A different public synthetic password; selects deliberate auth failure only.
const differentSyntheticPasswordHash =
  "$6$bigbudS2fixture$mrImJdKpld8BlpKic.1WyV4ZwS3J3gqVUW71JhLxAxFSnjBekI7d/8/TAOtQ8GGNljnEJaRQDUbHU0sHEvhOS0";

async function readPublicKey(file: string) {
  return (await readFile(`${file}.pub`, "utf8")).trim().split(" ").slice(0, 2).join(" ");
}

/** Disposable, source-only Linux picker. No sshd is left running by setup or preflight. */
export async function makeLinuxLoopbackPickerFixture({
  syntheticPassword = false,
  rejectSyntheticPassword = false,
  boundIdlePasswordMasterLifetime = false,
  addressFamily = "inet",
  observeKeyDaemon = false,
  hostKeyGate = false,
  outsideMaster = false,
  maxSessions = 10,
}: {
  readonly syntheticPassword?: boolean;
  readonly rejectSyntheticPassword?: boolean;
  readonly boundIdlePasswordMasterLifetime?: boolean;
  readonly addressFamily?: LinuxPickerAddressFamily;
  readonly observeKeyDaemon?: boolean;
  /** Key fixture only: serve the host key from a holdable test agent. */
  readonly hostKeyGate?: boolean;
  /** Start a test-owned outside master beside sshd in the private namespace. */
  readonly outsideMaster?: boolean;
  /** Destination-side session limit; the owner must report quota, never auth. */
  readonly maxSessions?: number;
} = {}) {
  if (hostKeyGate && (syntheticPassword || !observeKeyDaemon))
    throw new Error("The host-key gate needs the observed key-auth fixture.");
  if (addressFamily !== "inet" && addressFamily !== "inet6")
    throw new Error("Expected the private IPv4 or IPv6 loopback family.");
  if (syntheticPassword && (addressFamily !== "inet" || observeKeyDaemon))
    throw new Error("The disposable password fixture remains IPv4 only.");
  const loopback = linuxPickerAddress(addressFamily);
  if ((rejectSyntheticPassword || boundIdlePasswordMasterLifetime) && !syntheticPassword)
    throw new Error("Password fault cases require the disposable synthetic password fixture.");
  const uid = process.getuid?.() ?? 0;
  const gid = process.getgid?.() ?? 0;
  if (process.platform !== "linux" || !privateIds(uid, gid)) {
    throw new Error("The Linux picker requires Linux and a non-root user and group.");
  }
  for (const file of Object.values(tools)) {
    try {
      await access(file, constants.X_OK);
      const info = await stat(file);
      if (!info.isFile() || (info.mode & 0o6000) !== 0) throw new Error("Not an unprivileged tool");
    } catch (cause) {
      throw new Error(`The private Linux picker requires a non-setuid, executable ${file}.`, {
        cause,
      });
    }
  }

  const awkAlternative = await linuxPickerAwkAlternative();
  const root = await mkdtemp("/tmp/bigbud-picker-linux-");
  const sandboxArgs = linuxPickerSandboxArgs(root, uid, gid, syntheticPassword, awkAlternative);
  const setupArgs = syntheticPassword
    ? [...sandboxArgs, ...linuxPickerReadOnlyAncestors(syntheticPassword)]
    : sandboxArgs;
  const home = path.join(root, "home");
  const folder = path.join(home, "picker's folders; literal");
  const identity = path.join(root, "identity");
  const hostKey = path.join(root, "host-key");
  const knownHosts = path.join(root, "known_hosts");
  const entry = path.join(root, "start-daemon");
  const host = `[${loopback}]:${port}`;
  let gate: Awaited<ReturnType<typeof startHostKeyAgentGate>> | undefined;
  const dispose = async () => {
    await gate?.close();
    await rm(root, { recursive: true, force: true });
  };
  const sandbox = (args: string[], timeout = 5_000) =>
    execute(tools.sandbox, [...setupArgs, "--", ...args], {
      cwd: root,
      env: {},
      timeout,
      killSignal: "SIGKILL",
      maxBuffer: 64 * 1024,
    });
  const writePrivate = (name: string, content: string) =>
    writeFile(path.join(root, name), content, { mode: 0o600 });
  try {
    await mkdir(home, { mode: 0o700 });
    await mkdir(path.join(folder, "alpha"), { recursive: true });
    await mkdir(path.join(folder, "Z repo", ".git"), { recursive: true });
    await mkdir(path.join(folder, ".hidden"));
    await writeFile(path.join(folder, "not a folder"), "fixture\n");
    await writePrivate("passwd", `${user}:x:${uid}:${gid}:Picker:${home}:/bin/sh\n`);
    await writePrivate("group", `${user}:x:${gid}:\n`);
    await writePrivate(
      "nsswitch.conf",
      "passwd: files\ngroup: files\nshadow: files\nhosts: files\n",
    );
    if (syntheticPassword) {
      const hash = rejectSyntheticPassword ? differentSyntheticPasswordHash : syntheticPasswordHash;
      await writePrivate("shadow", `${user}:${hash}:20000:0:99999:7:::\n`);
    }
    if (hostKeyGate) gate = await startHostKeyAgentGate(root);
    await writePrivate(
      "sshd_config",
      renderLinuxPickerSshdConfig(
        root,
        syntheticPassword,
        boundIdlePasswordMasterLifetime,
        addressFamily,
        gate?.sshdConfig,
        maxSessions,
      ),
    );
    await writePrivate(
      "start-daemon",
      renderLinuxPickerDaemonEntrypoint(root, uid, gid, syntheticPassword, {
        addressFamily,
        observeKeyDaemon,
        outsideMaster,
      }),
    );
    await writePrivate("known_hosts", "");
    for (const file of gate ? [identity] : [identity, hostKey]) {
      await sandbox([
        tools.keygen,
        "-q",
        "-t",
        "ed25519",
        "-N",
        "",
        "-C",
        "picker-fixture",
        "-f",
        file,
      ]);
    }
    if (!syntheticPassword) {
      await writePrivate("authorized_keys", `restrict ${await readPublicKey(identity)}\n`);
    }
  } catch (cause) {
    await dispose();
    throw new Error(
      "Could not initialize the Linux picker sandbox. Unprivileged user and network namespaces and compatible Bubblewrap/OpenSSH are required.",
      { cause },
    );
  }

  return {
    root,
    home,
    folder,
    loopback,
    port,
    user,
    identity,
    knownHosts,
    host,
    ssh: tools.ssh,
    keyscan: tools.keyscan,
    getHostPublicKey: () => readPublicKey(hostKey),
    hostKeyGate: gate,
    async readKeyDaemonLog() {
      if (!observeKeyDaemon) throw new Error("Expected the observed key-auth fixture.");
      return readFile(path.join(root, linuxPickerKeyDaemonLog), "utf8");
    },
    async readPasswordDaemonLog() {
      if (!syntheticPassword) throw new Error("Expected the synthetic password fixture.");
      return readFile(path.join(root, linuxPickerPasswordDaemonLog), "utf8");
    },
    async installOwner(
      source: string,
      {
        mountDeploymentPublicKey = false,
        mountWorkspaceMachineId = false,
        guardedApplyProof = false,
        snapshotCancellation = false,
        keyboardInteractiveProof = false,
        sessionBudgetProof = undefined as number | undefined,
        // An owned master lane checks its lease parent, so freeze /tmp as for passwords.
        ownedMasterLane = false,
      } = {},
    ) {
      if (!path.isAbsolute(source))
        throw new Error("The Linux picker owner path must be absolute.");
      if (
        snapshotCancellation &&
        (syntheticPassword ||
          guardedApplyProof ||
          ownedMasterLane ||
          outsideMaster ||
          addressFamily !== "inet")
      )
        throw new Error("Snapshot cancellation requires the ordinary direct key fixture.");
      await access(source, constants.X_OK);
      const binary = path.join(root, "picker-owner");
      const launcher = path.join(root, "start-picker-owner");
      await copyFile(source, binary, constants.COPYFILE_EXCL);
      await chmod(binary, 0o700);
      const args = [...sandboxArgs];
      if (snapshotCancellation)
        args.push("--setenv", "BIGBUD_SSH_OWNER_SNAPSHOT_CANCEL_FIXTURE", "approved-disposable");
      if (guardedApplyProof)
        args.push("--setenv", "BIGBUD_SSH_OWNER_GUARDED_WRITE_APPLY_PROOF", "approved-disposable");
      if (keyboardInteractiveProof)
        args.push("--setenv", "BIGBUD_SSH_OWNER_KEYBOARD_INTERACTIVE_PROOF", "approved-disposable");
      if (sessionBudgetProof !== undefined)
        args.push("--setenv", "BIGBUD_SSH_OWNER_SESSION_BUDGET_PROOF", String(sessionBudgetProof));
      if (mountDeploymentPublicKey)
        args.push("--ro-bind", `${hostKey}.pub`, "/etc/ssh/ssh_host_ed25519_key.pub");
      if (mountWorkspaceMachineId) {
        // Never bind the guest's actual machine identity into a fixture.
        await writePrivate("workspace-machine-id", "bcba79aaa18a45008bee40f35a165dfc\n");
        args.push("--ro-bind", path.join(root, "workspace-machine-id"), "/etc/machine-id");
      }
      await writeFile(
        launcher,
        renderLinuxPickerOwnerLauncher(args, root, syntheticPassword || ownedMasterLane),
        {
          flag: "wx",
          mode: 0o700,
        },
      );
      return launcher;
    },
    async start() {
      // Check isolation and bind readiness only. Rust owns all picker SSH client launches.
      try {
        await sandbox(["/bin/sh", entry, "/bin/true"], 8_000);
      } catch (cause) {
        throw new Error("Private Linux loopback sshd preflight failed.", { cause });
      }
    },
    dispose,
  };
}
