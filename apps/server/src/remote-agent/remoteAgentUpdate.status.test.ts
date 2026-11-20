import { describe, expect, it } from "vitest";

import {
  emptyRemoteAgentRegistry,
  parseRemoteAgentRegistry,
  type RemoteAgentRegistry,
  type RemoteAgentRegistryBuild,
} from "./remoteAgentInstall.registry.ts";
import { statusFromState } from "./remoteAgentUpdate.status.ts";

const ROOT = "/home/u/.bigbud/agent";

function build(digest: string, triple: string, promotion: number): RemoteAgentRegistryBuild {
  const sha256 = digest.repeat(64);
  const statePath = `${ROOT}/runtimes/g-${digest}`;
  return {
    id: `0.4.0-beta.5:${sha256}:${triple}`,
    runtime: {
      generation: `g-${digest}`,
      version: "0.4.0-beta.5",
      sha256,
      buildDigest: "commit",
      targetTriple: triple,
      origin: "managed",
      binaryPath: `${ROOT}/bin/0.4.0-beta.5/${sha256}/bigbud-remote-agent`,
      statePath,
      socketPath: `${statePath}/supervisor.sock`,
      logPath: `${statePath}/supervisor.log`,
    },
    health: promotion > 0 ? "healthy" : "staged",
    promotion,
    binary: "present",
    authenticated: true,
  };
}

const gnu = build("a", "x86_64-unknown-linux-gnu", 1);
const musl = build("b", "x86_64-unknown-linux-musl", 0);

function registry(patch: Partial<RemoteAgentRegistry>): RemoteAgentRegistry {
  return parseRemoteAgentRegistry(
    JSON.stringify({
      ...emptyRemoteAgentRegistry(),
      promotionSequence: 1,
      builds: [gnu, musl],
      current: gnu.id,
      ...patch,
    }),
  );
}

describe("statusFromState", () => {
  it("never reports a successful outcome as the reason", () => {
    const status = statusFromState(
      "ssh:host=box&transport=agent",
      ROOT,
      registry({
        updates: [
          { requestId: "u1", buildId: musl.id, phase: "ready-for-reconnect", outcome: "ready" },
        ],
      }),
    );
    expect(status.phase).toBe("ready-for-reconnect");
    expect(status.outcome).toBe("ready");
    expect(status.reason).toBeNull();
  });

  it("keeps a real failure reason", () => {
    const status = statusFromState(
      "ssh:host=box&transport=agent",
      ROOT,
      registry({
        updates: [
          {
            requestId: "u1",
            buildId: musl.id,
            phase: "failed",
            outcome: "failed",
            reason: "Health check timed out.",
          },
        ],
      }),
    );
    expect(status.reason).toBe("Health check timed out.");
  });

  it("tells apart builds of the same version by triple and short digest", () => {
    const status = statusFromState(
      "ssh:host=box&transport=agent",
      ROOT,
      registry({
        updates: [{ requestId: "u1", buildId: musl.id, phase: "ready-for-reconnect" }],
      }),
    );
    expect(status.currentVersion).toBe(status.candidateVersion);
    expect(status).toMatchObject({
      currentTargetTriple: "x86_64-unknown-linux-gnu",
      currentBuildDigestShort: "aaaaaaaaaaaa",
      candidateTargetTriple: "x86_64-unknown-linux-musl",
      candidateBuildDigestShort: "bbbbbbbbbbbb",
    });
  });
});
