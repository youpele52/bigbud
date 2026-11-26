import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { expect, it, vi } from "vitest";

import { withSshOwnerDevTerminalManager } from "./sshOwnerDevTerminal.manager.fixture.ts";
import { pickerProofOptedIn } from "./sshOwnerPickerProof.integration.ts";

it.skipIf(!pickerProofOptedIn || process.platform !== "darwin").each([
  { name: "closes the exact native lease before preparing a replacement", uncertain: false },
  { name: "leaves the original lease reserved when close is uncertain", uncertain: true },
])(
  "C07 manager Restart $name",
  ({ uncertain }) =>
    withSshOwnerDevTerminalManager(
      "restart",
      ({ fixture, targetId, pane, key, reader, owner, fallback, adapter, spawn, makeManager }) =>
        Effect.gen(function* () {
          const manager = yield* makeManager({ resolveQuitIntent: Effect.succeed(Option.none()) });
          let output = "";
          const restarted = vi.fn();
          yield* manager.subscribe((event) =>
            Effect.sync(() => {
              if (event.type === "output") output += event.data;
              if (event.type === "restarted") restarted(event);
            }),
          );
          const nativeClose = owner.closeProofTerminal.bind(owner);
          const nativePrepare = owner.prepareProofTerminal.bind(owner);
          const nativeOpen = owner.openReservedProofTerminal.bind(owner);
          const prepare = vi.spyOn(owner, "prepareProofTerminal");
          const open = vi.spyOn(owner, "openReservedProofTerminal");
          const close = vi.spyOn(owner, "closeProofTerminal");
          const legacyOpen = vi.spyOn(owner, "openProofTerminal");
          const original = yield* manager.open(pane);
          expect(original.status).toBe("running");
          if (original.pid === null) throw new Error("Missing original native SSH process");
          const oldPid = original.pid;
          yield* manager.write({
            ...pane,
            expectedGeneration: original.runtimeGeneration,
            data: "printf '<%s>\\n' \"$((20 + 1))\"\r",
          });
          yield* Effect.promise(() =>
            vi.waitFor(() => expect(output).toMatch(/\r?\n<21>\r?\n/), 5_000),
          );
          const oldRoute = yield* Effect.promise(() => reader.get(key));
          if (!oldRoute) throw new Error("Missing original native SSH reservation");
          expect(oldRoute).toMatchObject({
            target: targetId,
            terminalCwd: pane.cwd,
            state: "may-have-been-sent",
          });
          const oldLease = Buffer.from(oldRoute.resourceId, "hex");
          expect(open).toHaveBeenCalledExactlyOnceWith(oldLease);
          const network = fixture.connectionStarts();
          const accepted = fixture.acceptedPublicKeys();
          // Restart opens one authenticated cwd probe before it reaches the close boundary.
          // Count that separately from any new PTY connection.
          const request = {
            ...pane,
            expectedGeneration: original.runtimeGeneration,
            operationId: "explicit-restart",
            shellSelection: { kind: "legacy-auto" } as const,
          };

          if (uncertain) {
            // Inject loss before dispatch: the manager cannot know whether this close ran.
            close.mockRejectedValueOnce(new Error("fixture close transport receipt unavailable"));
            const error = yield* Effect.flip(manager.restart(request));
            expect(error).toMatchObject({
              _tag: "TerminalExecutionTargetError",
              detail: expect.stringContaining("could not confirm termination"),
            });
            expect(error).not.toHaveProperty("reason", "restartNotStarted");
            expect(close).toHaveBeenCalledExactlyOnceWith(oldLease);
            expect(spawn).toHaveBeenCalledOnce();
            expect(prepare).toHaveBeenCalledTimes(1);
            expect(open).toHaveBeenCalledTimes(1);
            expect(restarted).not.toHaveBeenCalled();
            expect(fixture.connectionStarts()).toBe(network + 1);
            expect(fixture.acceptedPublicKeys()).toBe(accepted + 1);
            expect(yield* Effect.promise(() => reader.get(key))).toEqual(oldRoute);
            yield* Effect.promise(() =>
              expect(owner.proofTerminalStatus(oldLease)).resolves.toMatchObject({
                pid: oldPid,
                live: true,
              }),
            );
            const snapshot = yield* manager.snapshot(pane);
            expect(snapshot?.runtimeGeneration).toBe(original.runtimeGeneration);
            yield* manager.close(pane);
            expect(close.mock.calls).toEqual([[oldLease], [oldLease]]);
            expect(yield* Effect.promise(() => reader.get(key))).toEqual({
              ...oldRoute,
              state: "terminal",
            });
          } else {
            close.mockImplementationOnce(async (lease) => {
              expect(lease).toEqual(oldLease);
              expect(await reader.get(key)).toEqual(oldRoute);
              const receipt = await nativeClose(lease);
              expect(Buffer.from(receipt.lease)).toEqual(oldLease);
              expect(receipt).toMatchObject({ pid: oldPid, live: false });
              expect(() => process.kill(oldPid, 0)).toThrow(
                expect.objectContaining({ code: "ESRCH" }),
              );
              expect(await reader.get(key)).toEqual(oldRoute);
              expect(prepare).toHaveBeenCalledTimes(1);
              expect(open).toHaveBeenCalledTimes(1);
              return receipt;
            });
            prepare.mockImplementationOnce(async (input) => {
              expect(await reader.get(key)).toEqual({ ...oldRoute, state: "terminal" });
              return nativePrepare(input);
            });
            open.mockImplementationOnce(async (lease) => {
              const reservation = await reader.get(key);
              expect(reservation).toMatchObject({
                epoch: oldRoute.epoch,
                connectionId: oldRoute.connectionId,
                resourceId: Buffer.from(lease).toString("hex"),
                state: "may-have-been-sent",
              });
              expect(reservation?.reservationId).not.toBe(oldRoute.reservationId);
              expect(lease).not.toEqual(oldLease);
              // A delayed dispatch of the old lease cannot consume the new native grant.
              await expect(nativeOpen(oldLease)).rejects.toMatchObject({ code: "operationDenied" });
              return nativeOpen(lease);
            });
            const replacement = yield* manager.restart(request);
            expect(close).toHaveBeenCalledExactlyOnceWith(oldLease);
            expect(spawn).toHaveBeenCalledTimes(2);
            expect(spawn.mock.calls[1]?.[0]).toMatchObject({
              replaceTerminalOwner: true,
              recoverOnly: false,
            });
            yield* Effect.promise(async () => {
              // Surface hook assertions that an adapter would otherwise translate to a generic error.
              await close.mock.results[0]?.value;
              await prepare.mock.results[1]?.value;
              await open.mock.results[1]?.value;
            });
            if (prepare.mock.calls.length === 1) {
              // Keep proving durable close even when the replacement failed before native prepare.
              expect(yield* Effect.promise(() => reader.get(key))).toEqual({
                ...oldRoute,
                state: "terminal",
              });
            }
            expect(
              replacement.status,
              "manager failed to start a replacement after confirmed close",
            ).toBe("running");
            expect(replacement.runtimeGeneration).not.toBe(original.runtimeGeneration);
            expect(replacement.pid).not.toBe(oldPid);
            expect(prepare).toHaveBeenCalledTimes(2);
            expect(open).toHaveBeenCalledTimes(2);
            expect(restarted).toHaveBeenCalledOnce();
            const newLease = open.mock.calls[1]![0];
            expect(yield* Effect.promise(() => reader.get(key))).toMatchObject({
              resourceId: Buffer.from(newLease).toString("hex"),
              state: "may-have-been-sent",
            });
            yield* manager.write({
              ...pane,
              expectedGeneration: replacement.runtimeGeneration,
              data: "printf '<%s>\\n' \"$((20 + 2))\"\r",
            });
            yield* Effect.promise(() =>
              vi.waitFor(() => expect(output).toMatch(/\r?\n<22>\r?\n/), 5_000),
            );
            expect(fixture.connectionStarts()).toBe(network + 2);
            expect(fixture.acceptedPublicKeys()).toBe(accepted + 2);
            const lifecycle = adapter.ownedRuntimeForTarget?.(targetId)?.localSshClient;
            if (!lifecycle) throw new Error("Missing native SSH lifecycle");
            yield* Effect.promise(() =>
              expect(lifecycle.close(oldRoute)).rejects.toThrow("stays reserved"),
            );
            expect(close).toHaveBeenCalledExactlyOnceWith(oldLease);
            yield* manager.close(pane);
            expect(close.mock.calls).toEqual([[oldLease], [newLease]]);

            const attachOnly = yield* Effect.result(manager.open({ ...pane, attachOnly: true }));
            expect(attachOnly).toMatchObject({
              _tag: "Failure",
              failure: { _tag: "TerminalNotRunningError" },
            });
            const ordinaryOpen = yield* Effect.result(manager.open(pane));
            if (ordinaryOpen._tag === "Success")
              expect(ordinaryOpen.success.status).not.toBe("running");
            expect(prepare).toHaveBeenCalledTimes(2);
            expect(open).toHaveBeenCalledTimes(2);
          }
          expect(legacyOpen).not.toHaveBeenCalled();
          expect(fallback).not.toHaveBeenCalled();
        }),
    ),
  60_000,
);
