import type { PtySpawnInput } from "../terminal/Services/PTY.ts";
import { shellProfileId } from "../terminal/Layers/ShellProfiles.identity.ts";
import { remoteShellHost } from "../terminal/Layers/ShellProfiles.remote.identity.ts";
import type { RemoteAgentOwner } from "./remoteAgentOwners.ts";
import {
  remoteAgentPtyRequestDigest,
  type RemoteAgentShellLaunch,
} from "./remoteAgentShellLaunch.ts";

export const target = "ssh:host=example.test&user=alice&transport=agent";
export function profileLaunch(): RemoteAgentShellLaunch {
  const host = remoteShellHost({ executionTargetId: target });
  const executable = "/usr/bin/zsh";
  const args = ["-o", "nopromptsp"];
  return {
    version: 1,
    cwd: "/srv/project",
    requestedProfile: {
      host,
      profileId: shellProfileId(host, executable, args, "linux"),
      kind: "zsh",
    },
    executable,
    args,
    platform: "linux",
    integration: "disabled",
  };
}
export function spawnInput(shellLaunch?: RemoteAgentShellLaunch): PtySpawnInput {
  return {
    ownerKey: "pane",
    executionTargetId: target,
    remoteCwd: "/srv/project",
    cwd: "/desktop",
    shell: "ssh",
    cols: 80,
    rows: 24,
    env: { TERM: "xterm-256color", HOME: "/desktop", SECRET_KEY: "private" },
    ...(shellLaunch ? { shellLaunch } : {}),
  };
}
export function profileOwner(shellLaunch?: RemoteAgentShellLaunch): RemoteAgentOwner {
  const sha256 = "a".repeat(64);
  return {
    ownerKey: "terminal:pane",
    target,
    connectionId: "connection-1",
    runtime: {
      generation: "g1",
      version: "0.2.207",
      sha256,
      buildDigest: "fixture",
      targetTriple: "aarch64-unknown-linux-gnu",
      origin: "managed",
      binaryPath: `/tmp/agent/bin/0.2.207/${sha256}/bigbud-remote-agent`,
      statePath: "/tmp/agent/runtimes/g1",
      socketPath: "/tmp/agent/runtimes/g1/supervisor.sock",
      logPath: "/tmp/agent/runtimes/g1/supervisor.log",
    },
    epoch: "epoch-1",
    resourceId: "pty-1",
    digest: Buffer.from(
      remoteAgentPtyRequestDigest({
        target,
        cwd: "/srv/project",
        ...(shellLaunch ? { shellLaunch } : {}),
      }),
    ).toString("hex"),
    ...(shellLaunch ? { shellLaunch } : {}),
    state: "may-have-been-sent",
    outputSequence: 0,
    nextInputSequence: 1,
    inputAcknowledged: 0,
  };
}
