import { describe, expect, it } from "vitest";

import type { Project } from "../../models/types";
import {
  buildRemoteAgentHosts,
  remoteAgentHostStatus,
  remoteAgentHostStatusLabel,
  type RemoteAgentHostConnectionState,
} from "./RemoteAgentManagementSection.logic";

const AGENT_B = "ssh:host=beta&user=me&auth=ssh-key&transport=agent";
const DIRECT_A = "ssh:host=alpha&auth=ssh-key&transport=direct-ssh";
const AGENT_C = "ssh:host=charlie&port=2222&auth=ssh-key&transport=agent";

function project(id: string, target: string, patch: Partial<Project> = {}): Project {
  return {
    id: id as Project["id"],
    name: id,
    cwd: "/work",
    workspaceExecutionTargetId: target as Project["workspaceExecutionTargetId"],
    defaultModelSelection: null,
    scripts: [],
    ...patch,
  } as Project;
}

const empty: RemoteAgentHostConnectionState = {
  disconnectedExecutionTargetIds: {},
  verifiedExecutionTargetIds: {},
  executionTargetChecks: {},
  remoteConnections: {},
};

describe("buildRemoteAgentHosts", () => {
  it("lists every remote host of both transports once, skipping local and deleting projects", () => {
    const hosts = buildRemoteAgentHosts(
      [
        project("p1", AGENT_B),
        project("p2", AGENT_B),
        project("p3", DIRECT_A),
        project("local", "local"),
        project("gone", AGENT_C, { deletingAt: "2026-11-20T00:00:00.000Z" }),
      ],
      empty,
    );
    expect(hosts.map((host) => [host.hostLabel, host.transport, host.projects.length])).toEqual([
      ["alpha", "direct-ssh", 1],
      ["me@beta", "agent", 2],
    ]);
  });

  it("sorts connected hosts first, then by host name, and never treats a flag as connected", () => {
    const hosts = buildRemoteAgentHosts(
      [project("p1", AGENT_B), project("p2", DIRECT_A), project("p3", AGENT_C)],
      {
        ...empty,
        verifiedExecutionTargetIds: { [AGENT_C]: true, [DIRECT_A]: true },
        disconnectedExecutionTargetIds: { [DIRECT_A]: true },
        remoteConnections: {
          [AGENT_B]: { currentVersion: "0.4.0", pendingVersion: null, fallbackVersion: null },
        },
      },
    );
    expect(hosts.map((host) => [host.hostLabel, host.connected])).toEqual([
      ["me@beta", true],
      ["charlie:2222", true],
      ["alpha", false],
    ]);
    expect(hosts[0]?.agentVersion).toBe("0.4.0");
  });

  it("knows SSH succeeded only from this session's verification or a verified check", () => {
    const [fromCheck] = buildRemoteAgentHosts([project("p", DIRECT_A)], {
      ...empty,
      executionTargetChecks: { [DIRECT_A]: { status: "verified" } },
    });
    expect(fromCheck?.hasConnectedOverSsh).toBe(true);
    const [unverified] = buildRemoteAgentHosts([project("p", DIRECT_A)], {
      ...empty,
      executionTargetChecks: { [DIRECT_A]: { status: "error" } },
    });
    expect(unverified?.hasConnectedOverSsh).toBe(false);
    expect(unverified?.connected).toBe(false);
  });
});

describe("remoteAgentHostStatus", () => {
  it("reports the running version, a removal this session, or not checked", () => {
    const [host] = buildRemoteAgentHosts([project("p", AGENT_B)], {
      ...empty,
      remoteConnections: {
        [AGENT_B]: { currentVersion: "0.4.0", pendingVersion: null, fallbackVersion: null },
      },
    });
    expect(remoteAgentHostStatusLabel(remoteAgentHostStatus(host!, false))).toBe("Agent 0.4.0");
    expect(remoteAgentHostStatusLabel(remoteAgentHostStatus(host!, true))).toBe("Not installed");
    const [unknown] = buildRemoteAgentHosts([project("p", AGENT_B)], empty);
    expect(remoteAgentHostStatusLabel(remoteAgentHostStatus(unknown!, false))).toBe("Not checked");
  });
});
