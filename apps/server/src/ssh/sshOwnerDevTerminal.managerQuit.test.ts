import { PassThrough } from "node:stream";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { expect, it, vi } from "vitest";

import { AppQuitIntent, AppQuitIntentLive } from "../lifecycle/AppQuitIntent.ts";
import { consumeDesktopLifecycleHints } from "../system-sleep/desktopLifecycleHintReader.ts";
import { SystemSleepEpochsLive } from "../system-sleep/Layers/SystemSleepEpochs.ts";
import { withSshOwnerDevTerminalManager } from "./sshOwnerDevTerminal.manager.fixture.ts";
import { pickerProofOptedIn } from "./sshOwnerPickerProof.integration.ts";

const hintServices = Layer.mergeAll(AppQuitIntentLive, SystemSleepEpochsLive);

it.skipIf(!pickerProofOptedIn || process.platform !== "darwin").each([
  { name: "closes the exact lease on quit with default settings", hinted: true, keep: false },
  { name: "closes the exact lease on quit even in keep mode", hinted: true, keep: true },
  { name: "leaves the exact lease live without a quit hint", hinted: false, keep: false },
])(
  "C07 manager shutdown $name",
  ({ hinted, keep }) =>
    withSshOwnerDevTerminalManager(
      "quit",
      ({ fixture, targetId, pane, key, reader, owner, fallback, spawn, makeManager }) =>
        Effect.gen(function* () {
          const intent = yield* AppQuitIntent;
          const prepare = vi.spyOn(owner, "prepareProofTerminal");
          const open = vi.spyOn(owner, "openReservedProofTerminal");
          const close = vi.spyOn(owner, "closeProofTerminal");
          const legacyOpen = vi.spyOn(owner, "openProofTerminal");
          const keepRunningAfterQuit = vi.fn(() => keep);
          const { route, lease, pid, starts, accepted } = yield* Effect.scoped(
            Effect.gen(function* () {
              const manager = yield* makeManager({
                resolveQuitIntent: intent.resolve,
                keepRunningAfterQuit,
              });
              let output = "";
              yield* manager.subscribe((event) =>
                Effect.sync(() => {
                  if (event.type === "output") output += event.data;
                }),
              );
              const original = yield* manager.open(pane);
              expect(original.status).toBe("running");
              if (original.pid === null) throw new Error("Missing native SSH process");
              const pid = original.pid;
              yield* manager.write({
                ...pane,
                expectedGeneration: original.runtimeGeneration,
                data: "printf '<%s>\\n' \"$((20 + 4))\"\r",
              });
              yield* Effect.promise(() =>
                vi.waitFor(() => expect(output).toMatch(/\r?\n<24>\r?\n/), 5_000),
              );
              const route = yield* Effect.promise(() => reader.get(key));
              if (!route) throw new Error("Missing committed native SSH reservation");
              expect(route).toMatchObject({
                target: targetId,
                terminalCwd: pane.cwd,
                state: "may-have-been-sent",
              });
              const lease = Buffer.from(route.resourceId, "hex");
              const live = yield* Effect.promise(() => owner.proofTerminalStatus(lease));
              expect(Buffer.from(live.lease)).toEqual(lease);
              expect(live).toMatchObject({ pid, live: true });
              const starts = fixture.connectionStarts();
              const accepted = fixture.acceptedPublicKeys();
              if (hinted) {
                const pipe = new PassThrough();
                const acks = vi.fn(() => true);
                pipe.end(
                  `${JSON.stringify({ kind: "quit", sequence: 1, reason: "quit", occurredAt: Date.now(), online: null })}\n`,
                );
                yield* consumeDesktopLifecycleHints(pipe, { writeAck: acks });
                expect(acks).toHaveBeenCalledExactlyOnceWith({ sequence: 1 });
              }
              expect(close).not.toHaveBeenCalled();
              return { route, lease, pid, starts, accepted };
            }),
          );
          // Only the manager scope has stopped. The Rust owner and sshd are still available.
          expect(keepRunningAfterQuit).toHaveBeenCalledOnce();
          if (hinted) {
            expect(close).toHaveBeenCalledExactlyOnceWith(lease);
            const receipt = yield* Effect.promise(async () => await close.mock.results[0]?.value);
            if (!receipt) throw new Error("Missing exact native SSH close receipt");
            expect(Buffer.from(receipt.lease)).toEqual(lease);
            expect(receipt).toMatchObject({ pid, live: false });
            expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
            // A confirmed close retires the handle; status must no longer accept it.
            yield* Effect.promise(() =>
              expect(owner.proofTerminalStatus(lease)).rejects.toMatchObject({
                code: "operationDenied",
              }),
            );
          } else {
            expect(close).not.toHaveBeenCalled();
            const status = yield* Effect.promise(() => owner.proofTerminalStatus(lease));
            expect(Buffer.from(status.lease)).toEqual(lease);
            expect(status).toMatchObject({ pid, live: true });
          }
          expect(yield* Effect.promise(() => reader.get(key))).toEqual({
            ...route,
            state: hinted ? "terminal" : route.state,
          });
          expect(spawn).toHaveBeenCalledOnce();
          expect(prepare).toHaveBeenCalledOnce();
          expect(open).toHaveBeenCalledExactlyOnceWith(lease);
          expect(legacyOpen).not.toHaveBeenCalled();
          expect(fallback).not.toHaveBeenCalled();
          expect(fixture.connectionStarts()).toBe(starts);
          expect(fixture.acceptedPublicKeys()).toBe(accepted);
        }).pipe(Effect.provide(hintServices)),
    ),
  60_000,
);
