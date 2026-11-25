import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { WS_METHODS } from "@bigbud/contracts/constants/websocket.constant.ts";
import { Effect, Fiber, Layer } from "effect";
import { expect, it, vi } from "vitest";

import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { makeRoutesLayer } from "../server.routes.ts";
import { buildAppUnderTest } from "../server.test.app.ts";
import { defaultProjectId } from "../server.test.fixtures.ts";
import { serverHttpTestLayer } from "../server.test.http.ts";
import { attemptRawUpgrade } from "../server.test.remote.ts";
import { getWsServerUrl, serverTestLayer, withWsRpcClient } from "../server.test.rpc.ts";
import * as connections from "./sshMonitor.connections.ts";
import { activateDevSshOwner } from "./sshOwnerDevMode.fixture.ts";
import { makeSshOwnerDevPicker } from "./sshOwnerDevPicker.ts";
import { DevSshOwnerRuntime } from "./sshOwnerDevRuntime.ts";
import { startPickerProofOwner } from "./sshOwnerPickerProof.client.ts";
import {
  pickerProofOptedIn,
  proofOptions,
  storageScope,
} from "./sshOwnerPickerProof.integration.ts";
import { makeLoopbackPickerFixture } from "./sshPicker.loopback.fixture.ts";

it.skipIf(process.platform !== "darwin" || !pickerProofOptedIn)(
  "shares an authenticated WebSocket monitor probe until the last reader cancels",
  async () => {
    const fixture = await makeLoopbackPickerFixture({ authenticationGate: true });
    const gate = fixture.authGate;
    let phase = "server startup";
    try {
      if (!gate) throw new Error("Expected disposable authentication gate");
      const launch = await proofOptions(fixture);
      const targetId = fixture.executionTargetId;
      await writeFile(fixture.knownHosts, `${fixture.host} ${fixture.hostPublicKey}\n`, {
        mode: 0o600,
      });
      await fixture.start();
      activateDevSshOwner();
      const project = {
        projectId: defaultProjectId,
        title: "Disposable monitor workspace",
        providerRuntimeExecutionTargetId: "local",
        workspaceExecutionTargetId: targetId,
        executionTargetId: targetId,
        workspaceRoot: fixture.folder,
        defaultModelSelection: null,
        scripts: [],
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        deletingAt: null,
        deletedAt: null,
      };
      const projects = Layer.mock(ProjectionProjectRepository)({
        listAll: () => Effect.succeed([project]),
      });
      // This call-through attaches the real reader synchronously. Observe it rather than
      // sleeping and assuming the second socket reached the coalescer before interruption.
      const read = vi.spyOn(connections, "isConnectedSshMonitorTarget");
      const probes: { target: string; signal: AbortSignal; outcome: Promise<unknown> }[] = [];
      await storageScope(path.join(fixture.root, "monitor-ws.sqlite"), (sql) =>
        Effect.gen(function* () {
          const startOwner = vi.fn(async (profileBinding: Uint8Array) => {
            const owner = await startPickerProofOwner({
              ...launch,
              profileBinding,
              posixPickerCancellation: true,
              sql,
            });
            const sample = owner.sampleCancellableProofHealth;
            vi.spyOn(owner, "sampleCancellableProofHealth").mockImplementation((target, signal) => {
              const result = sample(target, signal);
              probes.push({ target, signal, outcome: result.catch((error: unknown) => error) });
              return result;
            });
            return owner;
          });
          const picker = yield* Effect.acquireRelease(
            Effect.sync(() =>
              makeSshOwnerDevPicker({
                executionTargetId: targetId,
                host: fixture.host,
                startOwner,
              }),
            ),
            (value) => Effect.promise(value.close),
          );
          const runtime = Layer.succeed(DevSshOwnerRuntime, {
            session: {
              kind: "unix",
              alias: "proof-monitor-cancel",
              targetId,
              fixture,
              picker,
              sql,
              terminal: undefined,
            },
          });
          const authToken = randomUUID();
          yield* buildAppUnderTest({
            config: { authToken },
            routes: makeRoutesLayer.pipe(Layer.provide(Layer.merge(runtime, projects))),
          });
          phase = "unauthenticated upgrade";
          const url = yield* getWsServerUrl("/ws");
          expect(yield* Effect.promise(() => attemptRawUpgrade(url))).toMatchObject({
            status: 401,
            upgraded: false,
          });
          const wsUrl = `${url}?token=${authToken}`;
          yield* withWsRpcClient(wsUrl, (a) =>
            withWsRpcClient(wsUrl, (b) =>
              withWsRpcClient(wsUrl, (fresh) =>
                Effect.gen(function* () {
                  const input = { executionTargetId: targetId, cwd: fixture.folder };
                  const list = WS_METHODS.serverListConnectedSshMonitors;
                  const verify = WS_METHODS.serverVerifyExecutionTarget;
                  const expected = [
                    { projectId: project.projectId, name: project.title, target: targetId },
                  ];
                  for (const [index, client] of [a, b, fresh].entries()) {
                    phase = `socket ${index + 1} admission check`;
                    expect(yield* client[list]({})).toEqual([]);
                    phase = `socket ${index + 1} verify`;
                    yield* client[verify](input);
                  }
                  const baseline = fixture.connectionStarts();
                  const wait = (assertion: () => void | Promise<void>) =>
                    Effect.promise(() => vi.waitFor(assertion, { timeout: 2_000, interval: 10 }));
                  const arm = () => Effect.promise(gate.arm);
                  const release = () => Effect.promise(gate.release);
                  const held = () =>
                    wait(async () => {
                      expect(await gate.isHeld()).toBe(true);
                    });
                  const waitForReaders = (count: number) =>
                    wait(() => {
                      expect(read).toHaveBeenCalledTimes(count);
                    });
                  const waitForInterrupt = (index: number) =>
                    wait(() => {
                      expect(read.mock.calls[index]?.[3]?.aborted).toBe(true);
                    });

                  phase = "arm health gate";
                  yield* arm();
                  const first = yield* Effect.forkScoped(a[list]({}));
                  yield* held();
                  const peer = yield* Effect.forkScoped(b[list]({}));
                  yield* waitForReaders(2);
                  expect(read.mock.calls[0]?.[1]).not.toBe(read.mock.calls[1]?.[1]);
                  expect(probes).toHaveLength(1);
                  phase = "interrupt first reader";
                  yield* Fiber.interrupt(first);
                  yield* waitForInterrupt(0);
                  expect(probes[0]?.signal.aborted).toBe(false);
                  expect(fixture.connectionStarts()).toBe(baseline + 1);
                  yield* release();
                  phase = "join surviving reader";
                  expect(yield* Fiber.join(peer)).toEqual(expected);
                  expect(yield* Effect.promise(() => probes[0]!.outcome)).toBe(true);

                  // Expire only the JS monitor's freshness; keep real transport timers.
                  vi.useFakeTimers({ toFake: ["Date"] });
                  vi.setSystemTime(Date.now() + 5_001);
                  phase = "arm health gate";
                  yield* arm();
                  const cancelFirst = yield* Effect.forkScoped(a[list]({}));
                  yield* held();
                  const cancelLast = yield* Effect.forkScoped(b[list]({}));
                  yield* waitForReaders(4);
                  expect(probes).toHaveLength(2);
                  const active = probes[1]!;
                  expect(active.target).toBe(targetId);
                  yield* Fiber.interrupt(cancelFirst);
                  yield* waitForInterrupt(2);
                  expect(active.signal.aborted).toBe(false);
                  phase = "interrupt last reader";
                  yield* Fiber.interrupt(cancelLast);
                  yield* waitForInterrupt(3);
                  expect(active.signal.aborted).toBe(true);
                  expect(probes[0]?.signal.aborted).toBe(false);
                  // Observe the exact native request's response before opening the remote gate.
                  expect(
                    yield* Effect.promise(() => active.outcome).pipe(Effect.timeout("2 seconds")),
                  ).toMatchObject({ code: "healthCancelled" });
                  expect(fixture.connectionStarts()).toBe(baseline + 2);
                  yield* release();
                  phase = "fresh reader";
                  expect(yield* fresh[list]({})).toEqual(expected);
                  expect(probes).toHaveLength(3);
                  expect(probes[2]?.signal).not.toBe(active.signal);
                  expect(yield* Effect.promise(() => probes[2]!.outcome)).toBe(true);
                  expect(fixture.connectionStarts()).toBe(baseline + 3);
                  expect(startOwner).toHaveBeenCalledTimes(1);
                  expect(yield* Effect.promise(fixture.launchNames)).toEqual([]);
                }),
              ),
            ),
          );
        }).pipe(
          Effect.scoped,
          Effect.timeoutOrElse({
            duration: "30 seconds",
            orElse: () => Effect.fail(new Error(`Monitor proof timed out: ${phase}`)),
          }),
          Effect.provide(Layer.merge(serverTestLayer, serverHttpTestLayer)),
        ),
      );
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
      try {
        await gate?.release();
      } finally {
        await fixture.dispose();
      }
    }
  },
  60_000,
);
