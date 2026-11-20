import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import type { Duplex } from "node:stream";
import { buildSshCommandInvocation } from "../ssh/sshCommand.ts";
import { assertSshExecutionTargetReadyAsync } from "../ssh/sshVerification.ts";
import { inspectSshHostTrust } from "../ssh/sshHostTrust.ts";
import { hasLocalSupervisorServiceControls } from "./localSupervisorService.paths.ts";
import { ownClientRelaySshChild } from "./clientRelay.ssh.child.ts";

export interface ClientRelayDeployment {
  readonly nodeBinary: string;
  readonly nodeSha256: string;
  readonly helperEntry: string;
  readonly helperSha256: string;
  readonly authorityId: string;
}
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
function command(deployment: ClientRelayDeployment) {
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
  return `set -eu; test "$(sha256sum ${quote(deployment.nodeBinary)} | cut -d ' ' -f 1)" = ${quote(deployment.nodeSha256)}; test "$(sha256sum ${quote(deployment.helperEntry)} | cut -d ' ' -f 1)" = ${quote(deployment.helperSha256)}; exec ${quote(deployment.nodeBinary)} ${quote(deployment.helperEntry)} ${quote(deployment.authorityId)}`;
}
/** Private local-backend owner. Call only with an admitted SSH target and verified installed graph.
 * No renderer commands, endpoints, real remote credentials or password/session duplication. */
export function makeClientRelaySshChannels(input: {
  readonly executionTargetId: string;
  readonly deployment: ClientRelayDeployment;
}) {
  const script = command(input.deployment);
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
