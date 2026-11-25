import { execFile, spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { vi } from "vitest";
import { installDevSshOwnerSandbox } from "./sshOwnerDevPicker.sandbox.ts";
import type { makeLoopbackPickerFixture } from "./sshPicker.loopback.fixture.ts";

const execute = promisify(execFile);

export async function installIsolatedPickerOwner(
  root: string,
  existingClientPolicy: string,
  attachmentSocket?: string,
  allowPty = attachmentSocket !== undefined,
  allowPosixPickerMaster = false,
  connectorExec: readonly string[] = [],
) {
  const configured = process.env.BIGBUD_SSH_OWNER_PICKER_PROOF_BIN;
  if (configured && !path.isAbsolute(configured)) {
    throw new Error("The proof binary path must be absolute.");
  }
  const artifact =
    configured ??
    fileURLToPath(new URL("../../../../target/debug/bigbud-ssh-owner", import.meta.url));
  const source = await realpath(artifact).catch((error: unknown) => {
    throw new Error("Build the bigbud-ssh-owner Rust binary before opting into the test.", {
      cause: error,
    });
  });
  return installDevSshOwnerSandbox({
    root,
    source,
    existingClientPolicy,
    attachmentSocket,
    allowPty,
    allowPosixPickerMaster,
    connectorExec,
  });
}

/** A separately owned master on the exact test host; never inspect a user's control sockets. */
export async function withOutsideMaster<A>(
  fixture: Awaited<ReturnType<typeof makeLoopbackPickerFixture>>,
  hostKeyAlias: string,
  run: (assertAlive: () => Promise<void>) => Promise<A>,
): Promise<A> {
  const socket = path.join(fixture.root, "outside.sock");
  // No ambient OpenSSH config, keys, agent, forwarding, helper, or network destination.
  const args = [
    "-4",
    "-F",
    "/dev/null",
    "-p",
    String(fixture.port),
    "-l",
    fixture.user,
    "-i",
    fixture.identity,
    "-S",
    socket,
    "-o",
    "BatchMode=yes",
    "-o",
    "IdentityAgent=none",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "GlobalKnownHostsFile=none",
    "-o",
    `UserKnownHostsFile=${fixture.knownHosts}`,
    "-o",
    `HostKeyAlias=${hostKeyAlias}`,
    "-o",
    "UpdateHostKeys=no",
    "-o",
    "ClearAllForwardings=yes",
    "-o",
    "VerifyHostKeyDNS=no",
    "-o",
    "ConnectTimeout=2",
    "-o",
    "ConnectionAttempts=1",
    "-o",
    "ControlPersist=no",
  ];
  const destination = ["--", fixture.loopback];
  const env = { ...fixture.env };
  const child = spawn(fixture.ssh, [...args, "-M", "-N", "-T", ...destination], {
    cwd: fixture.root,
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let exited = false;
  let diagnostic = "";
  child.stderr.on("data", (data: Buffer) => {
    diagnostic = (diagnostic + data.toString()).slice(-2048);
  });
  child.on("error", (cause) => {
    diagnostic = cause.message;
  });
  const closed = new Promise<void>((resolve) =>
    child.once("close", () => {
      exited = true;
      resolve();
    }),
  );
  const assertAlive = async () => {
    if (exited) throw new Error(`Owned outside master exited: ${diagnostic}`);
    // Avoid invoking a probe that could fall back to a fresh SSH connection.
    if (!(await lstat(socket)).isSocket()) throw new Error("Fixture control socket is not ready");
    await execute(fixture.ssh, [...args, "-O", "check", ...destination], {
      cwd: fixture.root,
      env,
      timeout: 2_000,
    });
  };
  try {
    await vi.waitFor(assertAlive, { timeout: 5_000 });
    return await run(assertAlive);
  } finally {
    if (!exited) child.kill("SIGTERM");
    const force = setTimeout(() => {
      if (!exited) child.kill("SIGKILL");
    }, 1_000);
    try {
      await closed;
    } finally {
      clearTimeout(force);
    }
  }
}
