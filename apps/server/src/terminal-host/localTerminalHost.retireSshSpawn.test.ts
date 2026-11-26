import { describe, expect, it, vi } from "vitest";

import type { RemoteAgentConnection } from "../remote-agent/remoteAgentConnection.ts";
import type { RemoteAgentRuntimeBinding } from "../remote-agent/remoteAgentConnectionPool.ts";
import type { RemoteAgentFrame } from "../remote-agent/remoteAgentProtocol.ts";
import {
  TERMINAL_HOST_RETIREMENT_CAPABILITY,
  type TerminalHostPane,
} from "../remote-agent/remoteAgentProtocol.terminalHost.ts";
import {
  TerminalHostRetirementError,
  TerminalHostRetirementUnsupportedError,
  inventoryLocalTerminalHost,
  retireLocalTerminalHostSshSpawn,
} from "./localTerminalHost.retirement.ts";

const binding = {
  connectionId: "state-1",
  expectedEpoch: "epoch-1",
  runtime: { buildDigest: "digest-1" },
} as unknown as RemoteAgentRuntimeBinding;

const pane = (id: string, kind: TerminalHostPane["kind"] = "local"): TerminalHostPane => ({
  ptyId: id,
  threadId: `thread-${id}`,
  paneId: `pane-${id}`,
  kind,
  ownerArtifactId: "1.0.0@digest-1",
  leaseId: id,
  canRetireSshSpawn: kind === "managed-ssh",
});

function host(
  input: {
    readonly panes?: ReadonlyArray<TerminalHostPane>;
    readonly capability?: boolean;
    readonly errorCode?: string;
    readonly truncated?: boolean;
  } = {},
) {
  const requests: RemoteAgentFrame[] = [];
  const connection = {
    supportsCapability: () => input.capability ?? true,
    request: vi.fn(async (frame: RemoteAgentFrame) => {
      requests.push(frame);
      if (frame.type === "terminalHostInventoryRequest")
        return {
          type: "terminalHostInventoryResponse",
          value: {
            requestId: (frame.value as { readonly requestId: string }).requestId,
            agentEpoch: binding.expectedEpoch,
            agentVersion: "1.0.0",
            buildDigest: "digest-1",
            ownerArtifactId: "1.0.0@digest-1",
            panes: input.panes ?? [],
            truncated: input.truncated ?? false,
            sshSpawnRetirementAvailable: true,
            accepted: input.errorCode === undefined,
            errorCode: input.errorCode ?? "",
          },
        } satisfies RemoteAgentFrame;
      return {
        type: "terminalHostRetireSshSpawnResponse",
        value: {
          requestId: (frame.value as { readonly requestId: string }).requestId,
          agentEpoch: binding.expectedEpoch,
          accepted: input.errorCode === undefined,
          retiredLeaseIds:
            input.errorCode === undefined
              ? [...(frame.value as { readonly leaseIds: ReadonlyArray<string> }).leaseIds]
              : [],
          sshSpawnRetired: input.errorCode === undefined,
          errorCode: input.errorCode ?? "",
          errorMessage: "",
        },
      } satisfies RemoteAgentFrame;
    }),
  } as unknown as RemoteAgentConnection;
  return {
    requests,
    pool: { getBound: vi.fn(async () => connection) },
  };
}

describe("terminal-host retirement verbs", () => {
  it("lists local and managed-SSH panes with exact lease identity", async () => {
    const view = host({ panes: [pane("a"), pane("b", "managed-ssh")] });
    const response = await inventoryLocalTerminalHost({ pool: view.pool, binding });
    expect(response.panes.map((entry) => [entry.ptyId, entry.kind, entry.leaseId])).toEqual([
      ["a", "local", "a"],
      ["b", "managed-ssh", "b"],
    ]);
    expect(response.ownerArtifactId).toBe("1.0.0@digest-1");
    expect(view.requests[0]).toMatchObject({
      type: "terminalHostInventoryRequest",
      value: { expectedEpoch: "epoch-1", maxPanes: 64 },
    });
  });

  it("refuses an older host instead of inferring retirement", async () => {
    const view = host({ capability: false });
    await expect(inventoryLocalTerminalHost({ pool: view.pool, binding })).rejects.toBeInstanceOf(
      TerminalHostRetirementUnsupportedError,
    );
    await expect(
      retireLocalTerminalHostSshSpawn({ pool: view.pool, binding, leaseIds: ["a"] }),
    ).rejects.toBeInstanceOf(TerminalHostRetirementUnsupportedError);
  });

  it("retires the exact lease set and requires the acknowledgement", async () => {
    const view = host();
    const response = await retireLocalTerminalHostSshSpawn({
      pool: view.pool,
      binding,
      leaseIds: ["lease-a", "lease-b"],
    });
    expect(response.accepted).toBe(true);
    expect(response.sshSpawnRetired).toBe(true);
    expect(response.retiredLeaseIds).toEqual(["lease-a", "lease-b"]);
    expect(view.requests[0]).toMatchObject({
      type: "terminalHostRetireSshSpawnRequest",
      value: { expectedEpoch: "epoch-1", expectedBuildDigest: "digest-1" },
    });
  });

  it("refuses duplicate, foreign or tampered leases locally and remotely", async () => {
    const view = host();
    await expect(
      retireLocalTerminalHostSshSpawn({ pool: view.pool, binding, leaseIds: ["a", "a"] }),
    ).rejects.toBeInstanceOf(TerminalHostRetirementError);
    const foreign = host({ errorCode: "HOST_LEASE_MISMATCH" });
    await expect(
      retireLocalTerminalHostSshSpawn({ pool: foreign.pool, binding, leaseIds: ["foreign"] }),
    ).rejects.toThrow(/HOST_LEASE_MISMATCH/);
    // A host that acknowledges a different set is not trusted.
    const mismatch = host();
    mismatch.pool.getBound = vi.fn(async () => {
      const connection = await host().pool.getBound();
      return {
        ...(connection as object),
        supportsCapability: () => true,
        request: async (frame: RemoteAgentFrame) =>
          frame.type === "terminalHostRetireSshSpawnRequest"
            ? {
                type: "terminalHostRetireSshSpawnResponse",
                value: {
                  requestId: (frame.value as { readonly requestId: string }).requestId,
                  agentEpoch: "epoch-1",
                  accepted: true,
                  retiredLeaseIds: ["other"],
                  sshSpawnRetired: true,
                  errorCode: "",
                  errorMessage: "",
                },
              }
            : connection.request(frame, () => true),
      } as unknown as RemoteAgentConnection;
    });
    await expect(
      retireLocalTerminalHostSshSpawn({ pool: mismatch.pool, binding, leaseIds: ["a"] }),
    ).rejects.toBeInstanceOf(TerminalHostRetirementError);
  });

  it("rejects oversized, truncated and malformed inventory responses", async () => {
    const tooMany = Array.from({ length: 65 }, (_, index) => pane(`p-${index}`));
    const oversized = host({ panes: tooMany });
    await expect(inventoryLocalTerminalHost({ pool: oversized.pool, binding })).rejects.toThrow(
      /too many panes/,
    );
    const truncated = host({ panes: [pane("a")], truncated: true });
    await expect(
      inventoryLocalTerminalHost({ pool: truncated.pool, binding, maxPanes: 2 }),
    ).rejects.toThrow(/truncated an invalid page/);
    const malformed = host({ panes: [{ ...pane("a"), leaseId: "other" }] });
    await expect(inventoryLocalTerminalHost({ pool: malformed.pool, binding })).rejects.toThrow(
      /invalid pane/,
    );
    await expect(
      inventoryLocalTerminalHost({ pool: host().pool, binding, maxPanes: 0 }),
    ).rejects.toBeInstanceOf(TerminalHostRetirementError);
    expect(TERMINAL_HOST_RETIREMENT_CAPABILITY).toBe("terminal.host-retirement");
  });
});
