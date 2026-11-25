import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { Effect } from "effect";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
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
import { compileSyntheticOpencode } from "./ServerManager.owner.native.service.ts";
import type { OwnedOpencodeServerInput } from "./ServerManager.owner.ts";

type LinuxFixture = Awaited<ReturnType<typeof makeLinuxLoopbackPickerFixture>>;

function assertLoopbackOnly() {
  const interfaces = Object.entries(networkInterfaces());
  if (
    interfaces.length !== 1 ||
    interfaces[0]?.[0] !== "lo" ||
    !interfaces[0][1]?.every(({ internal }) => internal) ||
    !interfaces[0][1]?.some(({ address }) => address === "127.0.0.1")
  ) {
    throw new Error("Run the OpenCode native proof in a fresh loopback-only network namespace.");
  }
}

async function installSharedNamespaceOwner(fixture: LinuxFixture, proofRoot: string) {
  const { root } = fixture;
  const uid = process.getuid!();
  const gid = process.getgid!();
  await fixture.installOwner(
    fileURLToPath(new URL("../../../../../../target/debug/bigbud-ssh-owner", import.meta.url)),
  );
  // The client must reach the actual native listener, with no relay on the test side.
  // Share only the outer test's isolated network; keep the inner PID and filesystem sandbox.
  const launcher = path.join(root, "start-opencode-owner");
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
  const sshdConfig = renderLinuxPickerSshdConfig(root).replace(
    "DisableForwarding yes",
    "AllowTcpForwarding local\nPermitOpen 127.0.0.1:4096\nAllowStreamLocalForwarding no",
  );
  await writeFile(path.join(root, "sshd_config"), sshdConfig);
  const keyPath = path.join(root, "authorized_keys");
  const key = await readFile(keyPath, "utf8");
  await writeFile(
    keyPath,
    key.replace(/^restrict /, 'restrict,port-forwarding,permitopen="127.0.0.1:4096" '),
  );
  const sshdLog = path.join(root, "opencode-sshd.log");
  await writeFile(
    path.join(root, "start-daemon"),
    renderLinuxPickerDaemonEntrypoint(root, uid, gid).replaceAll("/tmp/picker-sshd.log", sshdLog),
  );
  return { launcher, sshdLog };
}

export async function withNativeOpencodeOwner<A>(
  executable: string,
  run: (
    owner: LaunchedPickerProofOwner,
    input: Omit<OwnedOpencodeServerInput, "owner" | "signal">,
    readCommandStarts: () => Promise<number>,
  ) => Promise<A>,
): Promise<A> {
  assertLoopbackOnly();
  const synthetic = executable === "synthetic" || executable === "synthetic-stalled";
  if (!synthetic && !path.isAbsolute(executable)) {
    throw new Error("Expected an absolute OpenCode v1 binary path.");
  }
  const fixture = await makeLinuxLoopbackPickerFixture();
  let proofRoot: string | undefined;
  try {
    proofRoot = await mkdtemp("/tmp/bigbud-opencode-v1-");
    const { root, loopback, port, user, identity, knownHosts, ssh, keyscan } = fixture;
    const { launcher, sshdLog } = await installSharedNamespaceOwner(fixture, proofRoot);
    const cwd = path.join(proofRoot, "work");
    const binaryPath = path.join(proofRoot, "opencode");
    await mkdir(cwd, { mode: 0o700 });
    if (synthetic)
      await compileSyntheticOpencode(root, binaryPath, executable === "synthetic-stalled");
    else await copyFile(executable, binaryPath);
    await chmod(binaryPath, 0o500);
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(binaryPath)) digest.update(chunk);
    const sha256 = digest.digest("hex");
    const threadId = ThreadId.makeUnsafe("thread-opencode-native");
    const sessionEpoch = 9;
    const targetId = `ssh:${new URLSearchParams({ host: loopback, port: String(port), user, transport: "direct-ssh" })}`;
    const target = { location: "remote", executionTargetId: targetId } as const;
    const input = {
      threadId,
      sessionEpoch,
      binaryPath,
      providerRuntimeTarget: target,
      workspaceTarget: { ...target, cwd },
    };
    const readCommandStarts = async () =>
      [...(await readFile(sshdLog, "utf8")).matchAll(/Starting session: command\b/g)].length;
    return await storageScope(path.join(root, "opencode-proof.sqlite"), (sql) =>
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
          opencodeFixture: { binaryPath, sha256, cwd, threadId, sessionEpoch },
        });
        try {
          const trust = await owner.inspectTrust();
          if (trust.state !== "approvalRequired") throw new Error("Expected first-use approval");
          await owner.approveTrust(trust.challenge);
          return await run(owner, input, readCommandStarts);
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
