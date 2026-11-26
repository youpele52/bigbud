import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations.ts";
import { commitLegacyRetirement } from "../persistence/Layers/LegacyRetirement.ts";
import type { RemoteAgentRuntimeBinding } from "../remote-agent/remoteAgentConnectionPool.ts";
import type { RemoteAgentFrame } from "../remote-agent/remoteAgentProtocol.ts";
import type { TerminalHostPane } from "../remote-agent/remoteAgentProtocol.terminalHost.ts";
import { BackendInstance } from "../startup/backendInstance.ts";
import { ServerConfig } from "../startup/config.ts";
import type { LocalTerminalHostRetirementSource } from "../terminal-host/localTerminalHost.retirementSource.ts";
import { configureSshOwner, SshOwnerProductionBootLive } from "./sshOwnerProductionComposition.ts";

/**
 * Shared activated-boot harness. Each test file still mocks the activation
 * module and the owner spawn itself, because `vi.mock` is per file.
 */
export const bootActivatedStartup = (root: string, options: { readonly ownerPresent: boolean }) =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 185 });
    const sql = yield* SqlClient.SqlClient;
    const ownerPath = join(root, "bigbud-ssh-owner");
    if (options.ownerPresent) yield* Effect.promise(() => writeFile(ownerPath, "owner"));
    const config = { mode: "remote", devUrl: undefined, stateDir: root } as const;
    yield* configureSshOwner(config, "file:///unused", {
      activation: true,
      artifactOverride: {
        profile: "remote-backend",
        path: ownerPath,
        target: {} as never,
        evidence: "header",
      },
      ownerProfile: { stateDirectory: root, target: { targetId: "ssh:t" } as never },
    });
    yield* Layer.build(
      SshOwnerProductionBootLive.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ServerConfig, config as never),
            Layer.succeed(SqlClient.SqlClient, sql),
            Layer.succeed(BackendInstance, { assertHeld: async () => {} } as never),
          ),
        ),
      ),
    );
    return sql;
  });

export const retireProfile = (
  sql: SqlClient.SqlClient,
  root: string,
  pendingItems: ReadonlyArray<string> = [],
) =>
  commitLegacyRetirement(sql, {
    profileScope: root,
    artifactId: "build-a",
    decision: "drain-now",
    drainedLeases: [],
    pendingItems,
  });

const binding = {
  connectionId: "host-1",
  expectedEpoch: "epoch-1",
  runtime: { buildDigest: "digest-1", generation: "g1" },
} as unknown as RemoteAgentRuntimeBinding;

export const hostPane = (id: string, kind: TerminalHostPane["kind"]): TerminalHostPane => ({
  ptyId: id,
  threadId: `thread-${id}`,
  paneId: `pane-${id}`,
  kind,
  ownerArtifactId: "1.0.0@digest-1",
  leaseId: id,
  canRetireSshSpawn: kind === "managed-ssh",
});

/** A fake X2 host serving the protocol 1.10 `inventory` and `retireSshSpawn` verbs. */
export function fakeTerminalHost(input: {
  readonly panes: ReadonlyArray<TerminalHostPane>;
  readonly retirementCapability: boolean;
}) {
  const retired: string[][] = [];
  const connection = {
    supportsCapability: () => input.retirementCapability,
    request: vi.fn(async (frame: RemoteAgentFrame) => {
      const requestId = (frame.value as { readonly requestId: string }).requestId;
      if (frame.type === "terminalHostInventoryRequest")
        return {
          type: "terminalHostInventoryResponse",
          value: {
            requestId,
            agentEpoch: binding.expectedEpoch,
            agentVersion: "1.0.0",
            buildDigest: "digest-1",
            ownerArtifactId: "1.0.0@digest-1",
            panes: input.panes,
            truncated: false,
            sshSpawnRetirementAvailable: true,
            accepted: true,
            errorCode: "",
          },
        } satisfies RemoteAgentFrame;
      const leaseIds = [...(frame.value as { readonly leaseIds: ReadonlyArray<string> }).leaseIds];
      retired.push(leaseIds);
      return {
        type: "terminalHostRetireSshSpawnResponse",
        value: {
          requestId,
          agentEpoch: binding.expectedEpoch,
          accepted: true,
          retiredLeaseIds: leaseIds,
          sshSpawnRetired: true,
          errorCode: "",
          errorMessage: "",
        },
      } satisfies RemoteAgentFrame;
    }),
  };
  const source: LocalTerminalHostRetirementSource = {
    attachedBindings: async () => [{ binding }],
    pool: { getBound: async () => connection as never },
  };
  return { source, retired, connection };
}
