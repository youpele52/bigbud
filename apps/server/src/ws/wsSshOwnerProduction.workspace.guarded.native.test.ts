import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { expect, it } from "vitest";

import { initializeProductionSshGuardedWriteJournal } from "../persistence/Layers/SshOwnerGuardedWriteJournal.ts";
import {
  readExternalV2Target,
  withProductionV2Owner,
} from "../provider/Layers/OpencodeV2/ServerManager.sshOwner.production.native.fixture.ts";
import { storageScope } from "../ssh/sshOwnerPickerProof.integration.ts";
import type { SshOwnerProductionRegistration } from "../ssh/sshOwnerProductionRegistry.ts";
import { unsupportedWorkspaceMutations } from "../workspace-runtime/Services/WorkspaceMutations.ts";
import type { WorkspaceRuntimeShape } from "../workspace-runtime/Services/WorkspaceRuntime.ts";
import { WorkspacePathsLive } from "../workspace/Layers/WorkspacePaths.ts";
import { withWsSshOwnerProductionWorkspace } from "./wsSshOwnerProduction.workspace.ts";

// W2 T-files live proof: a production guarded (hash-checked) save on the target's
// own owner lane after a durable journal claim, a stale-hash conflict, and a
// journal replay that never dispatches twice. Same target JSON as
// `wsSshOwnerProduction.workspace.native.test.ts`.
const external = readExternalV2Target(process.env.BIGBUD_TEST_SSH_OWNER_PRODUCTION_FILES_TARGET);
const enabled =
  external !== undefined && (process.platform === "darwin" || process.platform === "linux");
const pathsLayer = WorkspacePathsLive.pipe(Layer.provide(NodeServices.layer));

it.skipIf(!enabled)(
  "saves guarded on the production owner, reports a conflict and replays from the journal",
  async () => {
    const state = await mkdtemp(path.join(tmpdir(), "bb-guarded-journal-"));
    try {
      await storageScope(path.join(state, "state.sqlite"), (sql) =>
        Effect.gen(function* () {
          const journal = yield* initializeProductionSshGuardedWriteJournal(sql, true);
          yield* Effect.promise(() =>
            withProductionV2Owner(
              external!,
              1,
              async ({ handle, targets }) => {
                const { descriptor, cwd } = targets[0]!;
                const bound = handle.target(descriptor);
                const trust = await bound.inspectTrust();
                if (trust.state === "approvalRequired") await bound.approveTrust(trust.challenge);
                const registration = {
                  handle,
                  descriptorFor: async () => descriptor,
                } as unknown as SshOwnerProductionRegistration;
                const refuse = () => Effect.die(new Error("default runtime reached"));
                const base: WorkspaceRuntimeShape = {
                  files: {
                    listDirectory: refuse,
                    readFilePreview: refuse,
                    readFileRange: refuse,
                    writeFile: refuse,
                  },
                  search: { searchEntries: refuse, searchFileContents: refuse },
                  watch: { watchDirectory: refuse },
                };
                const files = Effect.runSync(
                  withWsSshOwnerProductionWorkspace(
                    { workspaceRuntime: base, workspaceMutations: unsupportedWorkspaceMutations },
                    { activation: true, read: () => registration, journal },
                  )!.workspaceRuntime.pipe(Effect.provide(pathsLayer)),
                ).files;
                const input = {
                  executionTargetId: descriptor.targetId,
                  cwd,
                  relativePath: "g.txt",
                };
                const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
                await run(files.writeFile({ ...input, contents: "base\n" }));
                const preview = await run(files.readFilePreview(input));
                expect(preview).toMatchObject({ edit: { mode: "guarded" } });
                const operationId = randomUUID();
                const saved = await run(
                  files.writeFile({
                    ...input,
                    contents: "saved\n",
                    expectedSha256: preview.sha256!,
                    operationId,
                  }),
                );
                expect(saved).toMatchObject({
                  relativePath: "g.txt",
                  resultSha256: expect.any(String),
                });
                // The same intent replays the recorded receipt; it is never dispatched again.
                expect(
                  await run(
                    files.writeFile({
                      ...input,
                      contents: "saved\n",
                      expectedSha256: preview.sha256!,
                      operationId,
                    }),
                  ),
                ).toMatchObject({
                  resultSha256: (saved as unknown as { resultSha256: string }).resultSha256,
                });
                // A stale base hash is a typed conflict and leaves the file unchanged.
                const conflict = await run(
                  Effect.flip(
                    files.writeFile({
                      ...input,
                      contents: "lost\n",
                      expectedSha256: preview.sha256!,
                      operationId: randomUUID(),
                    }),
                  ),
                );
                expect(conflict).toMatchObject({ conflict: true, writeDisposition: "terminal" });
                expect((await run(files.readFilePreview(input))).contents).toBe("saved\n");
              },
              { binding: {} },
            ),
          );
        }),
      );
    } finally {
      await rm(state, { recursive: true, force: true });
    }
  },
  120_000,
);
