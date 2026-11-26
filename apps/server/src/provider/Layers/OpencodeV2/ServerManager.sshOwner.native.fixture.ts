import { Effect } from "effect";
import { randomBytes } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  startPickerProofOwner,
  type LaunchedPickerProofOwner,
} from "../../../ssh/sshOwnerPickerProof.client.ts";
import { storageScope } from "../../../ssh/sshOwnerPickerProof.integration.ts";
import {
  linuxPickerSandboxArgs,
  renderLinuxPickerDaemonEntrypoint,
  renderLinuxPickerOwnerLauncher,
  renderLinuxPickerSshdConfig,
} from "../../../ssh/sshPicker.loopback.fixture.linux.sandbox.ts";
import { makeLinuxLoopbackPickerFixture } from "../../../ssh/sshPicker.loopback.fixture.linux.ts";
import type { V2OwnerSessionSource } from "./ServerManager.ownerV2.selected.ts";
import type { V2IsolatedProcessConfig } from "./ServerManager.types.ts";

/**
 * Live Linux fixture for the owner-selected OpenCode v2 SSH lane: a real
 * `bigbud-ssh-owner` in fixture mode with `--opencode-v2-service`, a disposable
 * loopback sshd, and a real OpenCode v2 executable launched on the "remote".
 *
 * @module ServerManager.sshOwner.native.fixture
 */

type LinuxFixture = Awaited<ReturnType<typeof makeLinuxLoopbackPickerFixture>>;

export interface NativeV2Owner {
  readonly owner: LaunchedPickerProofOwner;
  readonly config: V2IsolatedProcessConfig;
  readonly source: V2OwnerSessionSource;
  readonly readCommandStarts: () => Promise<number>;
}

function assertLoopbackOnly() {
  const interfaces = Object.entries(networkInterfaces());
  if (
    interfaces.length !== 1 ||
    interfaces[0]?.[0] !== "lo" ||
    !interfaces[0][1]?.every(({ internal }) => internal) ||
    !interfaces[0][1]?.some(({ address }) => address === "127.0.0.1")
  ) {
    throw new Error("Run the OpenCode v2 native proof in a fresh loopback-only network namespace.");
  }
}

async function installSharedNamespaceOwner(fixture: LinuxFixture, proofRoot: string) {
  const { root } = fixture;
  const uid = process.getuid!();
  const gid = process.getgid!();
  await fixture.installOwner(
    fileURLToPath(new URL("../../../../../../target/debug/bigbud-ssh-owner", import.meta.url)),
  );
  // The client reaches the owner's native listener directly; only the outer
  // isolated network is shared, the inner PID and filesystem sandbox stay.
  const launcher = path.join(root, "start-opencode-v2-owner");
  await writeFile(
    launcher,
    renderLinuxPickerOwnerLauncher(
      [
        ...linuxPickerSandboxArgs(root, uid, gid).filter((arg) => arg !== "--unshare-net"),
        "--bind",
        proofRoot,
        proofRoot,
      ],
      root,
    ),
    { flag: "wx", mode: 0o700 },
  );
  // The v2 owner selects a remote loopback port in 49152-65535; sshd permits
  // only loopback forwards on that host.
  const sshdConfig = renderLinuxPickerSshdConfig(root).replace(
    "DisableForwarding yes",
    "AllowTcpForwarding local\nPermitOpen 127.0.0.1:*\nAllowStreamLocalForwarding no",
  );
  await writeFile(path.join(root, "sshd_config"), sshdConfig);
  const keyPath = path.join(root, "authorized_keys");
  const key = await readFile(keyPath, "utf8");
  await writeFile(
    keyPath,
    key.replace(/^restrict /, 'restrict,port-forwarding,permitopen="127.0.0.1:*" '),
  );
  const sshdLog = path.join(root, "opencode-v2-sshd.log");
  await writeFile(
    path.join(root, "start-daemon"),
    renderLinuxPickerDaemonEntrypoint(root, uid, gid).replaceAll("/tmp/picker-sshd.log", sshdLog),
  );
  return { launcher, sshdLog };
}

export async function withNativeOpencodeV2Owner<A>(
  executable: string,
  run: (native: NativeV2Owner) => Promise<A>,
): Promise<A> {
  assertLoopbackOnly();
  if (!path.isAbsolute(executable)) throw new Error("Expected an absolute OpenCode v2 binary.");
  const fixture = await makeLinuxLoopbackPickerFixture();
  let proofRoot: string | undefined;
  try {
    proofRoot = await mkdtemp("/tmp/bigbud-opencode-v2-");
    const { root, loopback, port, user, identity, knownHosts, ssh, keyscan } = fixture;
    const { launcher, sshdLog } = await installSharedNamespaceOwner(fixture, proofRoot);
    const cwd = path.join(proofRoot, "work");
    const binaryPath = path.join(proofRoot, "opencode");
    await mkdir(cwd, { mode: 0o700 });
    await copyFile(executable, binaryPath);
    await chmod(binaryPath, 0o500);
    const targetId = `ssh:${new URLSearchParams({ host: loopback, port: String(port), user, transport: "direct-ssh" })}`;
    const readCommandStarts = async () =>
      [...(await readFile(sshdLog, "utf8")).matchAll(/Starting session: command\b/g)].length;
    return await storageScope(path.join(root, "opencode-v2-proof.sqlite"), (sql) =>
      Effect.promise(async () => {
        const owner = await startPickerProofOwner({
          binary: launcher,
          sql,
          profileBinding: randomBytes(32),
          targetId,
          lockFile: path.join(root, "owner.lock"),
          sshBinary: ssh,
          keyscanBinary: keyscan,
          host: loopback,
          port,
          user,
          identityFile: identity,
          knownHostsFile: knownHosts,
          workspaceRoot: cwd,
          opencodeV2Service: { binaryPath },
        });
        try {
          const trust = await owner.inspectTrust();
          if (trust.state !== "approvalRequired") throw new Error("Expected first-use approval");
          await owner.approveTrust(trust.challenge);
          const lane = owner.opencodeV2Lane;
          if (!lane) throw new Error("The native owner did not expose the OpenCode v2 lane.");
          const source: V2OwnerSessionSource = {
            target: async (id) =>
              id === targetId
                ? { targetId, owner: undefined, lane, serviceBinding: binaryPath }
                : undefined,
          };
          const config: V2IsolatedProcessConfig = {
            runtimeTargetId: targetId,
            // Host-side setting; the composition replaces it with the owner binding.
            binaryPath: "/host/opencode",
            profileRoot: path.join(proofRoot!, "host-profile-unused"),
            workspaceRoot: cwd,
          };
          return await run({ owner, config, source, readCommandStarts });
        } finally {
          await owner.close();
        }
      }),
    );
  } finally {
    try {
      if (proofRoot) await rm(proofRoot, { recursive: true, force: true });
    } finally {
      await fixture.dispose();
    }
  }
}
