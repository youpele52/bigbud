import path from "node:path";
import { Effect } from "effect";
import { expect, it, vi } from "vitest";

import { withSshOwnerDevTerminalManager } from "./sshOwnerDevTerminal.manager.fixture.ts";
import { pickerProofOptedIn } from "./sshOwnerPickerProof.integration.ts";

it.skipIf(!pickerProofOptedIn || process.platform !== "darwin")(
  "reattaches the saved native lease in a cold manager without frontend history or a new SSH cwd probe",
  () =>
    withSshOwnerDevTerminalManager(
      "cold-reattach",
      ({ fixture, pane, key, reader, owner, fallback, spawn, makeManager }) =>
        Effect.gen(function* () {
          const prepare = vi.spyOn(owner, "prepareProofTerminal");
          const open = vi.spyOn(owner, "openReservedProofTerminal");
          const probe = vi.spyOn(owner, "probeProofTerminalCwd");
          const original = yield* Effect.scoped(
            Effect.gen(function* () {
              const manager = yield* makeManager();
              let output = "";
              yield* manager.subscribe((event) =>
                Effect.sync(() => {
                  if (event.type === "output") output += event.data;
                }),
              );
              const started = yield* manager.open(pane);
              expect(started.status).toBe("running");
              yield* manager.write({
                ...pane,
                expectedGeneration: started.runtimeGeneration,
                data: "printf '<%s>\\n' \"$((7 + 8))\"\r",
              });
              yield* Effect.promise(() =>
                vi.waitFor(() => expect(output).toMatch(/\r?\n<15>\r?\n/), 5_000),
              );
              return started;
            }),
          );
          const route = yield* Effect.promise(() => reader.get(key));
          if (!route) throw new Error("Missing the retained native route");
          expect(route.state).toBe("may-have-been-sent");
          const before = fixture.connectionStarts();
          const cwdProbes = probe.mock.calls.length;
          const manager = yield* makeManager({
            logsDir: path.join(fixture.root, "new-manager-no-history"),
          });
          const wrongRoot = yield* manager
            .open({ ...pane, cwd: fixture.home, attachOnly: true })
            .pipe(Effect.flip);
          expect(wrongRoot).toMatchObject({ _tag: "TerminalNotRunningError" });
          expect(spawn).toHaveBeenCalledOnce();
          const recovered = yield* manager.open({ ...pane, attachOnly: true });
          expect(recovered.status).toBe("running");
          expect(recovered.pid).toBe(original.pid);
          expect(yield* Effect.promise(() => reader.get(key))).toEqual(route);
          expect(probe).toHaveBeenCalledTimes(cwdProbes);
          expect(prepare).toHaveBeenCalledOnce();
          expect(open).toHaveBeenCalledOnce();
          expect(spawn).toHaveBeenCalledTimes(2);
          expect(spawn.mock.calls.at(-1)?.[0]).toMatchObject({
            recoverOnly: true,
            expectedRemoteResourceId: route.resourceId,
          });
          let resumedOutput = "";
          yield* manager.subscribe((event) =>
            Effect.sync(() => {
              if (event.type === "output") resumedOutput += event.data;
            }),
          );
          yield* manager.write({
            ...pane,
            expectedGeneration: recovered.runtimeGeneration,
            data: "printf '<%s>\\n' \"$((8 + 9))\"\r",
          });
          yield* Effect.promise(() =>
            vi.waitFor(() => expect(resumedOutput).toMatch(/\r?\n<17>\r?\n/), 5_000),
          );
          expect(fixture.connectionStarts()).toBe(before);
          expect(fallback).not.toHaveBeenCalled();
          yield* manager.close({ threadId: pane.threadId, terminalId: pane.terminalId });
        }),
    ),
  60_000,
);
