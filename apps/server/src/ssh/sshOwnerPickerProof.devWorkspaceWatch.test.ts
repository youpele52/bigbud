import { writeFile } from "node:fs/promises";
import path from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer, Stream } from "effect";
import { expect, it, vi } from "vitest";
import type { WorkspaceRuntimeShape } from "../workspace-runtime/Services/WorkspaceRuntime.ts";
import { WorkspacePathsLive } from "../workspace/Layers/WorkspacePaths.ts";
import { withWsSshOwnerDevWorkspace } from "../ws/wsSshOwnerDev.workspace.ts";
import { startPickerProofOwner } from "./sshOwnerPickerProof.client.ts";
import {
  pickerProofOptedIn,
  proofOptions,
  storageScope,
} from "./sshOwnerPickerProof.integration.ts";
import { makeLoopbackPickerFixture } from "./sshPicker.loopback.fixture.ts";

it.skipIf(!pickerProofOptedIn)(
  "routes the selected development workspace watch through the native owner",
  async () => {
    const fixture = await makeLoopbackPickerFixture();
    try {
      const options = await proofOptions(fixture);
      const targetId = options.targetId.replace("transport=agent", "transport=direct-ssh");
      await fixture.start();
      vi.stubEnv("HOME", fixture.home);
      vi.stubEnv("PATH", fixture.env.PATH);
      await storageScope(path.join(fixture.root, "dev-watch.sqlite"), (sql) =>
        Effect.promise(async () => {
          const owner = await startPickerProofOwner({
            ...options,
            sql,
            targetId,
            workspaceRoot: fixture.folder,
          });
          try {
            const trust = await owner.inspectTrust();
            if (trust.state !== "approvalRequired")
              throw new Error("Expected isolated first-use trust.");
            await owner.approveTrust(trust.challenge);
            const fallback = vi.fn(() => Effect.die("unexpected workspace fallback"));
            const original = {
              files: {
                listDirectory: fallback,
                readFilePreview: fallback,
                readFileRange: fallback,
                writeFile: fallback,
              },
              search: { searchEntries: fallback, searchFileContents: fallback },
              watch: { watchDirectory: fallback },
            } satisfies WorkspaceRuntimeShape;
            const runtime = await Effect.runPromise(
              withWsSshOwnerDevWorkspace(original, {
                targetId,
                workspaceRoot: fixture.folder,
                withOwner: async (target, use) => {
                  expect(target).toBe(targetId);
                  return use(owner);
                },
              }).pipe(Effect.provide(WorkspacePathsLive.pipe(Layer.provide(NodeServices.layer)))),
            );
            const watch = await Effect.runPromise(
              runtime.watch.watchDirectory({ executionTargetId: targetId, cwd: fixture.folder }),
            );
            let received = 0;
            let connectionsAfterDisconnect = 0;
            const events = await Effect.runPromise(
              Stream.runCollect(
                watch.pipe(
                  Stream.tap(() =>
                    Effect.promise(async () => {
                      if (received++ === 0)
                        await writeFile(path.join(fixture.folder, "watch-proof.txt"), "changed");
                      else if (received === 2) {
                        await owner.disconnect();
                        connectionsAfterDisconnect = fixture.connectionStarts();
                      } else if (received === 3) {
                        expect(fixture.connectionStarts()).toBe(connectionsAfterDisconnect);
                        await owner.connect();
                        expect(fixture.connectionStarts()).toBe(connectionsAfterDisconnect);
                      }
                    }),
                  ),
                  Stream.take(4),
                ),
              ).pipe(Effect.timeout("15 seconds")),
            );
            expect(events.map(({ type, generation }) => [type, generation])).toEqual([
              ["directoryChanged", 1],
              ["directoryChanged", 2],
              ["rescanRequired", 3],
              ["directoryChanged", 4],
            ]);
            expect(fixture.connectionStarts()).toBeGreaterThan(connectionsAfterDisconnect);
            let firstFinished!: () => void;
            const firstClosed = new Promise<void>((resolve) => {
              firstFinished = resolve;
            });
            const firstWatch = Stream.runHead(watch).pipe(
              Effect.tap(() => Effect.sync(firstFinished)),
            );
            const secondWatch = Stream.runCollect(
              watch.pipe(
                Stream.tap((event) =>
                  event.generation === 1
                    ? Effect.promise(async () => {
                        await firstClosed;
                        await writeFile(
                          path.join(fixture.folder, "second-watch-proof.txt"),
                          "changed",
                        );
                      })
                    : Effect.void,
                ),
                Stream.take(2),
              ),
            );
            const [, remainingEvents] = await Effect.runPromise(
              Effect.all([firstWatch, secondWatch], { concurrency: 2 }).pipe(
                Effect.timeout("15 seconds"),
              ),
            );
            expect(remainingEvents.map(({ generation }) => generation)).toEqual([1, 2]);
            expect(fallback).not.toHaveBeenCalled();
            expect(await fixture.launchNames()).toEqual([]);
          } finally {
            await owner.close();
          }
        }),
      );
    } finally {
      vi.unstubAllEnvs();
      await fixture.dispose();
    }
  },
  120_000,
);
