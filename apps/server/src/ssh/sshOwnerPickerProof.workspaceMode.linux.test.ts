import { createHash, randomBytes } from "node:crypto";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Effect } from "effect";
import type { OrchestrationCommand, OrchestrationReadModel } from "@bigbud/contracts";
import { expect, it, vi } from "vitest";

import { makeWorkspaceModeGate } from "../remote-backend/workspaceMode.gate.ts";
import { decodeWorkspaceModeRecord } from "../remote-backend/workspaceMode.record.ts";
import { runSshCommand } from "./sshProcess.ts";
import { workspaceModeForPickerProof } from "./sshOwnerPickerProof.workspaceMode.ts";
import { startPickerProofOwner } from "./sshOwnerPickerProof.client.ts";
import { storageScope } from "./sshOwnerPickerProof.integration.ts";
import { approve, live, withFixture } from "./sshOwnerPickerProof.scopedNative.fixture.ts";

vi.mock("./sshProcess.ts", () => ({ runSshCommand: vi.fn() }));

it.skipIf(!live)(
  "runs the Linux workspace-mode gate through pinned Rust inspect and publish without fallback",
  () =>
    withFixture(async (fixture) => {
      const binary = await fixture.installOwner(
        fileURLToPath(new URL("../../../../target/debug/bigbud-ssh-owner", import.meta.url)),
        { mountWorkspaceMachineId: true },
      );
      const executionTargetId = `ssh:${new URLSearchParams({
        host: fixture.loopback,
        port: String(fixture.port),
        user: fixture.user,
      })}`;
      await storageScope(path.join(fixture.root, "workspace-mode.sqlite"), (sql) =>
        Effect.promise(async () => {
          const owner = await startPickerProofOwner({
            binary,
            sql,
            profileBinding: randomBytes(32),
            targetId: executionTargetId,
            lockFile: path.join(fixture.root, "owner.lock"),
            sshBinary: fixture.ssh,
            keyscanBinary: fixture.keyscan,
            host: fixture.loopback,
            port: fixture.port,
            user: fixture.user,
            identityFile: fixture.identity,
            knownHostsFile: fixture.knownHosts,
            workspaceRoot: fixture.folder,
          });
          try {
            const input = { executionTargetId, root: fixture.folder };
            await expect(owner.inspectProofWorkspaceMode(input)).rejects.toMatchObject({
              code: "trustRequired",
            });
            await approve(owner);
            const result = await owner.inspectProofWorkspaceMode(input);
            expect(result).toMatchObject({
              state: "ready",
              physicalRoot: fixture.folder,
              hostIdentity: expect.stringMatching(/^machine-v1:[0-9a-f]{64}$/),
              accountUid: process.getuid?.(),
              realpathSha256: createHash("sha256").update(fixture.folder).digest("hex"),
              generation: 0,
            });
            await expect(lstat(path.join(fixture.home, ".bigbud"))).rejects.toMatchObject({
              code: "ENOENT",
            });
            const scope = { executionTargetId, workspaceRoot: fixture.folder };
            const publishProofWorkspaceMode = vi.fn(owner.publishProofWorkspaceMode);
            const sshOwner = workspaceModeForPickerProof(scope, {
              inspectProofWorkspaceMode: owner.inspectProofWorkspaceMode,
              publishProofWorkspaceMode,
            });
            const backendOwner = `backend-v1:${"a".repeat(64)}`;
            const gate = makeWorkspaceModeGate({
              serverMode: "desktop",
              owner: backendOwner,
              sshOwner,
            });
            const create = {
              type: "project.create",
              workspaceExecutionTargetId: executionTargetId,
              workspaceRoot: fixture.folder,
            } as OrchestrationCommand;
            const readModel = { projects: [], threads: [] } as unknown as OrchestrationReadModel;
            await Effect.runPromise(gate.check(create, readModel));
            expect(publishProofWorkspaceMode).toHaveBeenCalledTimes(1);
            const sent = publishProofWorkspaceMode.mock.lastCall?.[0];
            if (!sent) throw new Error("Missing native publication request");
            await expect(owner.publishProofWorkspaceMode(sent)).rejects.toMatchObject({
              code: "operationDenied",
            });
            const published = await owner.inspectProofWorkspaceMode(input);
            if (published.state !== "ready" || !published.currentRecord)
              throw new Error("Missing published record");
            expect(decodeWorkspaceModeRecord(published.currentRecord)).toMatchObject({
              generation: 1,
              mode: "laptop-runtime",
              owner: backendOwner,
            });
            await Effect.runPromise(gate.check(create, readModel));
            expect(publishProofWorkspaceMode).toHaveBeenCalledTimes(1);
            await owner.disconnect();
            await expect(Effect.runPromise(gate.check(create, readModel))).rejects.toMatchObject({
              detail: expect.stringContaining("could not complete"),
            });
            expect(runSshCommand).not.toHaveBeenCalled();
          } finally {
            await owner.close();
          }
        }),
      );
    }),
  60_000,
);
