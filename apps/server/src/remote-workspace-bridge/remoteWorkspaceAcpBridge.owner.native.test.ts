import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { Effect, Exit, Scope } from "effect";
import { expect, it, vi } from "vitest";

import type { ProviderAdapterError } from "../provider/Errors.ts";
import { makeAcpStartSessionTestDeps } from "../provider/Layers/AcpAdapter.startSession.test.helpers.ts";
import { resolveAcpSessionFsOwner } from "../provider/Layers/AcpRemoteWorkspace.session.ts";
import type { CursorSessionContext } from "../provider/Layers/Cursor/Adapter.helpers.ts";
import { makeStartSessionEffect as startCursor } from "../provider/Layers/Cursor/Adapter.startSession.ts";
import type { DevinSessionContext } from "../provider/Layers/Devin/Adapter.helpers.ts";
import { makeStartSessionEffect as startDevin } from "../provider/Layers/Devin/Adapter.startSession.ts";
import { createFakeAcpSessionRuntime } from "../provider/acp/AcpSessionRuntime.test.helpers.ts";
import { activateDevSshOwner } from "../ssh/sshOwnerDevMode.fixture.ts";
import { DevSshOwnerRuntime } from "../ssh/sshOwnerDevRuntime.ts";
import { startPickerProofOwner } from "../ssh/sshOwnerPickerProof.client.ts";
import {
  pickerProofOptedIn,
  proofOptions,
  storageScope,
} from "../ssh/sshOwnerPickerProof.integration.ts";
import { makeLoopbackPickerFixture } from "../ssh/sshPicker.loopback.fixture.ts";
import type { SessionFsOwnerWorkspace } from "./remoteWorkspaceSessionFsBridge.owner.ts";

vi.mock("../provider/acp/CursorAcpSupport.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../provider/acp/CursorAcpSupport.ts")>()),
  makeCursorAcpRuntime: vi.fn(),
}));
vi.mock("../provider/acp/DevinAcpSupport.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../provider/acp/DevinAcpSupport.ts")>()),
  makeDevinAcpRuntime: vi.fn(),
}));

import { makeCursorAcpRuntime } from "../provider/acp/CursorAcpSupport.ts";
import { makeDevinAcpRuntime } from "../provider/acp/DevinAcpSupport.ts";

it.skipIf(!pickerProofOptedIn || process.platform !== "darwin").each(["cursor", "devin"] as const)(
  "routes selected %s ACP session reads through the native owner without fallback",
  async (provider) => {
    activateDevSshOwner();
    const fixture = await makeLoopbackPickerFixture();
    try {
      const options = await proofOptions(fixture);
      const targetId = options.targetId.replace("transport=agent", "transport=direct-ssh");
      const workspaceRoot = fixture.folder;
      const fileName = "acp-native-proof.txt";
      const remoteFile = path.join(workspaceRoot, fileName);
      const bytes = Buffer.from("﻿α\r\nsecond\r\nlast\n", "utf8");
      await writeFile(remoteFile, bytes);
      await fixture.start();
      vi.stubEnv("HOME", fixture.home);
      vi.stubEnv("PATH", fixture.env.PATH);
      await storageScope(path.join(fixture.root, "acp-session.sqlite"), (sql) =>
        Effect.promise(async () => {
          const owner = await startPickerProofOwner({ ...options, sql, targetId, workspaceRoot });
          const notificationScope = await Effect.runPromise(Scope.make());
          const threadId = ThreadId.makeUnsafe(`native-acp-${provider}`);
          const cursorSessions = new Map<ThreadId, CursorSessionContext>();
          const devinSessions = new Map<ThreadId, DevinSessionContext>();
          try {
            const trust = await owner.inspectTrust();
            if (trust.state !== "approvalRequired") throw new Error("Expected fixture first use");
            await owner.approveTrust(trust.challenge);
            const ownerAccess = vi.fn();
            const withOwner: SessionFsOwnerWorkspace["withOwner"] = async (target, use) => {
              expect(target).toBe(targetId);
              ownerAccess();
              return use(owner);
            };
            const session = {
              kind: "unix",
              targetId,
              fixture: { folder: workspaceRoot },
              picker: { withOwner },
            } as NonNullable<(typeof DevSshOwnerRuntime.Service)["session"]>;
            const sessionFsOwner = await Effect.runPromise(
              resolveAcpSessionFsOwner().pipe(
                Effect.provideService(DevSshOwnerRuntime, { session }),
              ),
            );
            if (!sessionFsOwner) throw new Error("Expected selected ACP filesystem owner");
            const fallback = vi.fn(async () => {
              throw new Error("Unexpected legacy readiness or remote-agent fallback");
            });
            const acp = createFakeAcpSessionRuntime();
            const makeRuntime = vi.mocked(
              provider === "cursor" ? makeCursorAcpRuntime : makeDevinAcpRuntime,
            );
            makeRuntime.mockClear().mockReturnValue(Effect.succeed(acp));
            const deps = {
              notificationScope,
              sessionFsOwner,
              remoteWorkspaceReadinessProbe: fallback,
              remoteAgentPtyResolver: { resolveWorkspace: fallback, resolvePty: fallback },
            };
            const start = (cwd: string, workspaceExecutionTargetId: string) => {
              const input = {
                provider,
                threadId,
                cwd,
                workspaceExecutionTargetId,
                runtimeMode: "approval-required" as const,
              };
              const stateDir = fixture.root;
              const effect: Effect.Effect<
                { readonly cwd: string },
                ProviderAdapterError,
                Scope.Scope
              > =
                provider === "cursor"
                  ? startCursor(
                      {
                        ...makeAcpStartSessionTestDeps({ stateDir, sessions: cursorSessions }),
                        ...deps,
                        getCursorSettings: () =>
                          Effect.succeed({ binaryPath: "unused", apiEndpoint: "" }),
                      },
                      input,
                    )
                  : startDevin(
                      {
                        ...makeAcpStartSessionTestDeps({ stateDir, sessions: devinSessions }),
                        ...deps,
                        getDevinSettings: () => Effect.succeed({ binaryPath: "unused" }),
                      },
                      input,
                    );
              return Effect.runPromise(effect.pipe(Effect.scoped));
            };

            await expect(start(path.join(workspaceRoot, "Z repo"), targetId)).rejects.toThrow();
            await expect(
              start(workspaceRoot, "ssh:host=wrong.invalid&transport=direct-ssh"),
            ).rejects.toThrow();
            expect(makeRuntime).not.toHaveBeenCalled();
            expect(ownerAccess).not.toHaveBeenCalled();

            const started = await start(workspaceRoot, targetId);
            expect(makeRuntime).toHaveBeenCalledExactlyOnceWith(
              expect.objectContaining({
                clientCapabilities: expect.objectContaining({
                  fs: { readTextFile: true, writeTextFile: false },
                  terminal: false,
                }),
              }),
            );
            const [read] = vi.mocked(acp.handleReadTextFile).mock.calls[0]!;
            const [write] = vi.mocked(acp.handleWriteTextFile).mock.calls[0]!;
            const [terminal] = vi.mocked(acp.handleCreateTerminal).mock.calls[0]!;
            const bridgeFile = path.join(started.cwd, fileName);
            // A local fallback would see different bytes, even though the path exists.
            await writeFile(bridgeFile, "local decoy");
            const request = { sessionId: "acp-session-1", path: bridgeFile };
            const connectionsBeforeRead = fixture.connectionStarts();
            ownerAccess.mockClear();
            await expect(
              Effect.runPromise(read({ ...request, sessionId: "wrong-session" })),
            ).rejects.toThrow();
            await expect(
              Effect.runPromise(read({ ...request, path: "../outside" })),
            ).rejects.toThrow();
            await expect(
              Effect.runPromise(write({ ...request, content: "denied" })),
            ).rejects.toThrow();
            await expect(
              Effect.runPromise(terminal({ sessionId: request.sessionId, command: "pwd" })),
            ).rejects.toThrow();
            expect(ownerAccess).not.toHaveBeenCalled();
            expect(fixture.connectionStarts()).toBe(connectionsBeforeRead);

            const result = await Effect.runPromise(read(request));
            expect(Buffer.from(result.content, "utf8")).toEqual(bytes);
            expect(ownerAccess).toHaveBeenCalledTimes(1);
            expect(fixture.connectionStarts()).toBeGreaterThan(connectionsBeforeRead);

            const generation = owner.trackedGitTargetGeneration;
            await owner.disconnect();
            expect(owner.trackedGitTargetGeneration).not.toBe(generation);
            const disconnected = fixture.connectionStarts();
            await expect(Effect.runPromise(read(request))).rejects.toThrow(
              /session-filesystem is unavailable/,
            );
            expect(ownerAccess).toHaveBeenCalledTimes(2);
            expect(fixture.connectionStarts()).toBe(disconnected);
            expect(fallback).not.toHaveBeenCalled();
            expect(await fixture.launchNames()).toEqual([]);
            expect(await readFile(remoteFile)).toEqual(bytes);
          } finally {
            try {
              const started = cursorSessions.get(threadId) ?? devinSessions.get(threadId);
              await started?.orchestrationBridgeCleanup?.();
            } finally {
              try {
                await Effect.runPromise(Scope.close(notificationScope, Exit.void));
              } finally {
                await owner.close();
              }
            }
          }
        }),
      );
    } finally {
      vi.unstubAllEnvs();
      await fixture.dispose();
    }
  },
  60_000,
);
