import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import type { Duplex } from "node:stream";
import { buildSshCommandInvocation } from "../ssh/sshCommand.ts";
import { parseSshExecutionTarget } from "../ssh/sshExecutionTarget.ts";
import { assertSshExecutionTargetReadyAsync } from "../ssh/sshVerification.ts";
import { inspectSshHostTrust } from "../ssh/sshHostTrust.ts";
import { assertLegacySshLaunchAllowed } from "../ssh/sshOwnerSelection.ts";
import { hasLocalSupervisorServiceControls } from "./localSupervisorService.paths.ts";
import { ownClientRelaySshChild } from "./clientRelay.ssh.child.ts";

import {
  makeOwnedClientRelaySshChannels,
  type ClientRelayDeployment,
  type ClientRelayOwnerRequest,
  type ClientRelaySshOwner,
} from "./clientRelay.ssh.owner.ts";

export type { ClientRelayDeployment } from "./clientRelay.ssh.owner.ts";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
function validateDeployment(deployment: ClientRelayDeployment) {
  if (!/^[a-f0-9]{32}$/.test(deployment.authorityId)) throw new Error("Invalid backend authority.");
  for (const [path, digest] of [
    [deployment.nodeBinary, deployment.nodeSha256],
    [deployment.helperEntry, deployment.helperSha256],
  ]) {
    if (
      !path ||
      !isAbsolute(path) ||
      hasLocalSupervisorServiceControls(path) ||
      !/^[a-f0-9]{64}$/.test(digest ?? "")
    )
      throw new Error("Invalid verified relay deployment.");
  }
}

function command(deployment: ClientRelayDeployment) {
  return `set -eu; test "$(sha256sum ${quote(deployment.nodeBinary)} | cut -d ' ' -f 1)" = ${quote(deployment.nodeSha256)}; test "$(sha256sum ${quote(deployment.helperEntry)} | cut -d ' ' -f 1)" = ${quote(deployment.helperSha256)}; exec ${quote(deployment.nodeBinary)} ${quote(deployment.helperEntry)} ${quote(deployment.authorityId)}`;
}
/** Private local-backend owner. Call only with an admitted SSH target and verified installed graph.
 * No renderer commands, endpoints, real remote credentials or password/session duplication. */
export function makeClientRelaySshChannels(
  input: ClientRelayOwnerRequest & { readonly sshOwner?: ClientRelaySshOwner },
) {
  const { nodeBinary, nodeSha256, helperEntry, helperSha256, authorityId } = input.deployment;
  const deployment = Object.freeze({
    nodeBinary,
    nodeSha256,
    helperEntry,
    helperSha256,
    authorityId,
  });
  validateDeployment(deployment);
  if (input.sshOwner !== undefined) {
    const { executionTargetId } = input;
    if (parseSshExecutionTarget(executionTargetId)?.executionTargetId !== executionTargetId)
      throw new Error("Invalid backend relay SSH target.");
    return makeOwnedClientRelaySshChannels(
      Object.freeze({ executionTargetId, deployment }),
      input.sshOwner,
    );
  }
  // Reject an unbound selected owner before the profile can publish a loopback lease.
  assertLegacySshLaunchAllowed();
  const script = command(deployment);
  const active = new Set<Duplex>();
  const children = new Set<ReturnType<typeof ownClientRelaySshChild>>();
  let disposal: Promise<void> | undefined;
  let disposed = false;
  return {
    async openChannel(signal: AbortSignal): Promise<Duplex> {
      signal.throwIfAborted();
      if (disposed) throw new Error("Backend relay owner is disposed.");
      await assertSshExecutionTargetReadyAsync(input.executionTargetId);
      signal.throwIfAborted();
      if (disposed) throw new Error("Backend relay owner is disposed.");
      await inspectSshHostTrust(input.executionTargetId);
      signal.throwIfAborted();
      if (disposed) throw new Error("Backend relay owner is disposed.");
      const invocation = buildSshCommandInvocation({
        executionTargetId: input.executionTargetId,
        shellMode: "clean-posix",
        command: "/bin/sh",
        args: ["-c", script],
        transportArgs: [
          "-o",
          "StrictHostKeyChecking=yes",
          "-o",
          "UpdateHostKeys=no",
          "-o",
          "ClearAllForwardings=yes",
          "-o",
          "PermitLocalCommand=no",
          "-o",
          "ConnectTimeout=10",
          "-o",
          "ServerAliveInterval=15",
          "-o",
          "ServerAliveCountMax=3",
        ],
      });
      const child = spawn(invocation.command, invocation.args, { stdio: ["pipe", "pipe", "pipe"] });
      const owner = ownClientRelaySshChild(child, signal);
      children.add(owner);
      void owner.exited.then(() => children.delete(owner));
      active.add(owner.stream);
      owner.stream.once("close", () => active.delete(owner.stream));
      if (disposed) owner.stream.destroy();
      return owner.stream;
    },
    dispose() {
      disposed = true;
      for (const stream of active) stream.destroy();
      return (disposal ??= (async () => {
        const result = await Promise.allSettled(
          [...children].map((owner) => owner.waitForExit(2500)),
        );
        if (result.some((entry) => entry.status === "rejected"))
          throw new Error("SSH backend relay cleanup could not confirm owned child exit.");
      })());
    },
  };
}
