import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expect, vi } from "vitest";

vi.mock("../../ssh/sshProcess", () => ({
  runSshCommand: vi.fn(async (input: { args: string[] }) => ({
    stdout: `\x1e${input.args[3]}\x1f`,
    stderr: "",
    code: 0,
    signal: null,
    timedOut: false,
  })),
}));
import { wslTerminalTargetId } from "@bigbud/shared/terminalExecutionTarget";
import { ShellProfileDiscoveryError } from "../Services/ShellProfiles";
import { createManager, openInput, restartInput, waitFor } from "./Manager.test.helpers";
import { resolveShellProfileLaunch } from "./ShellProfiles.launch";
import { host } from "./Manager.shell.remote.test.helpers";
import {
  remoteFixture,
  target,
  profile,
  selection,
  unconfirmed,
} from "./Manager.shell.remote.test.helpers";

it.layer(NodeServices.layer, { excludeTestServices: true })(
  "owned remote Manager profiles",
  (it) => {
    it.effect(
      "routes fresh plans to internal owned intent, never desktop executable or actual identity",
      () =>
        Effect.gen(function* () {
          const { manager, adapter, targets, events } = yield* remoteFixture();
          const opened = yield* manager.open(
            openInput({ executionTargetId: target, cwd: "/work", shellSelection: selection }),
          );
          expect(targets).toEqual([target]);
          expect(adapter.spawnInputs).toHaveLength(1);
          expect(adapter.spawnInputs[0]).toMatchObject({
            ownerKey: JSON.stringify(["thread-1", "default"]),
            remoteCwd: "/work",
            shellLaunch: {
              executable: profile.executable,
              args: profile.args,
              cwd: "/work",
              integration: "disabled",
            },
          });
          expect(adapter.spawnInputs[0]?.shell).not.toBe(profile.executable);
          expect(opened.shellLaunchIdentity).toBeUndefined();
          expect(opened.shellUnconfirmedLaunch).toEqual(unconfirmed);
          expect((yield* manager.snapshot(openInput())).shellUnconfirmedLaunch).toEqual(
            unconfirmed,
          );
          const event = events.find((event) => event.type === "started");
          expect(event?.type === "started" && event.snapshot.shellUnconfirmedLaunch).toEqual(
            unconfirmed,
          );
          const again = yield* manager.open(
            openInput({ executionTargetId: target, shellSelection: selection }),
          );
          expect(again.runtimeGeneration).toBe(opened.runtimeGeneration);
          expect(targets).toHaveLength(1);
          expect(adapter.spawnInputs).toHaveLength(1);
          const mismatch = yield* manager
            .open(
              openInput({
                executionTargetId: target,
                shellSelection: { kind: "profile", profileId: "other" },
              }),
            )
            .pipe(Effect.result);
          expect(mismatch._tag).toBe("Failure");
          const restart = yield* manager
            .restart(restartInput({ executionTargetId: target, cwd: "/work" }))
            .pipe(Effect.result);
          expect(restart._tag).toBe("Failure");
          expect(adapter.processes[0]?.killSignals).toEqual([]);
          expect(targets).toHaveLength(1);
        }),
    );

    for (const fail of ["old-agent", "missing-profile"] as const) {
      it.effect(`${fail} preflights before replacement stop or preparation`, () =>
        Effect.gen(function* () {
          let unavailable = false;
          const { manager, adapter } = yield* remoteFixture({
            preflightRemoteShellProfile: () =>
              unavailable
                ? Effect.fail(new ShellProfileDiscoveryError({ reason: "unsupported-target" }))
                : Effect.void,
          });
          yield* manager.open(
            openInput({ executionTargetId: target, cwd: "/work", shellSelection: selection }),
          );
          let prepared = 0;
          Object.assign(adapter.processes[0]!, {
            prepareRestart: async () => {
              prepared++;
            },
          });
          unavailable = fail === "old-agent";
          const result = yield* manager
            .restart(
              restartInput({
                executionTargetId: target,
                cwd: "/work",
                shellSelection:
                  fail === "missing-profile"
                    ? { kind: "profile", profileId: "missing" }
                    : selection,
              }),
            )
            .pipe(Effect.result);
          expect(result._tag).toBe("Failure");
          if (result._tag === "Failure") {
            expect(result.failure).toMatchObject({
              _tag: "TerminalExecutionTargetError",
              threadId: "thread-1",
              terminalId: "default",
              reason: "restartNotStarted",
            });
          }
          const retained = yield* manager.snapshot(openInput());
          expect(retained.status).toBe("running");
          expect(retained.shellUnconfirmedLaunch).toEqual(unconfirmed);
          expect(retained.shellLaunchIdentity).toBeUndefined();
          expect(prepared).toBe(0);
          expect(adapter.processes[0]?.killSignals).toEqual([]);
          expect(adapter.spawnInputs).toHaveLength(1);
        }),
      );
    }

    for (const executionTargetId of [
      target.replace("transport=agent", "transport=direct-ssh"),
      wslTerminalTargetId("Ubuntu"),
    ]) {
      it.effect(`gates ${executionTargetId} before discovery or dispatch`, () =>
        Effect.gen(function* () {
          const { manager, adapter, targets } = yield* remoteFixture();
          expect(
            (yield* manager
              .open(openInput({ executionTargetId, shellSelection: selection }))
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
          expect(targets).toEqual([]);
          expect(adapter.spawnInputs).toEqual([]);
        }),
      );
    }

    it.effect("explicit remote dispatch failure has no local or account-shell fallback", () =>
      Effect.gen(function* () {
        const { manager, adapter } = yield* remoteFixture();
        adapter.spawnFailures.push(new Error("ENOENT"));
        const failed = yield* manager.open(
          openInput({ executionTargetId: target, cwd: "/work", shellSelection: selection }),
        );
        expect(failed.status).toBe("error");
        expect(failed.shellLaunchIdentity).toBeUndefined();
        expect(adapter.spawnInputs).toHaveLength(1);
      }),
    );

    for (const evidence of [true, false]) {
      it.effect(
        `processless ${evidence ? "unconfirmed" : "unknown"} cannot inherit selection/defaults and preserves history`,
        () =>
          Effect.gen(function* () {
            const { manager, adapter, events, targets } = yield* remoteFixture();
            if (!evidence) adapter.evidence = undefined;
            yield* manager.open(
              openInput({ executionTargetId: target, cwd: "/work", shellSelection: selection }),
            );
            adapter.processes[0]!.emitData("previous history\r\n");
            adapter.processes[0]!.emitExit({ exitCode: 0, signal: null });
            yield* waitFor(Effect.sync(() => events.some((event) => event.type === "exited")));
            const retained = yield* manager.snapshot(openInput());
            const result = yield* manager
              .open(openInput({ executionTargetId: target, cwd: "/work" }))
              .pipe(Effect.result);
            expect(result._tag).toBe("Failure");
            expect((yield* manager.snapshot(openInput())).history).toEqual(retained.history);
            expect(retained.history).toContain("previous history");
            expect(adapter.spawnInputs).toHaveLength(1);
            expect(targets).toHaveLength(1);
            yield* manager.open(
              openInput({ executionTargetId: target, cwd: "/work", shellSelection: selection }),
            );
            expect(adapter.spawnInputs).toHaveLength(2);
            expect(targets).toHaveLength(2);
          }),
      );
    }

    for (const action of ["open", "restart"] as const) {
      it.effect(
        `${action} recovery uses stored owner intent without current inventory/defaults`,
        () =>
          Effect.gen(function* () {
            const { manager, adapter, targets } = yield* remoteFixture(
              {
                preflightRemoteShellProfile: () => Effect.die("must not preflight recovery"),
                resolveShellProfile: () => Effect.die("must not rediscover recovery"),
              },
              "old unknown history\r\n",
            );
            adapter.recovered = true;
            const recovered = yield* manager[action](
              restartInput({ executionTargetId: target, cwd: "/work", shellSelection: selection }),
            );
            expect(recovered.shellUnconfirmedLaunch).toEqual(unconfirmed);
            expect(recovered.shellLaunchIdentity).toBeUndefined();
            expect(recovered.history).toContain("old unknown history");
            expect(adapter.spawnInputs[0]).toMatchObject({ recoverOnly: true });
            expect(adapter.spawnInputs[0]?.shellLaunch).toBeUndefined();
            expect(targets).toEqual([]);
            expect(adapter.spawnInputs).toHaveLength(1);
          }),
      );
    }

    it.effect("malformed resolved intent fails before stopping a live replacement", () =>
      Effect.gen(function* () {
        const launch = resolveShellProfileLaunch({ host, profiles: [profile], selection })!;
        let malformed = false;
        const { manager, adapter } = yield* remoteFixture({
          resolveShellProfile: () =>
            Effect.succeed(malformed ? { ...launch, shell: "relative-shell" } : launch),
        });
        yield* manager.open(
          openInput({ executionTargetId: target, cwd: "/work", shellSelection: selection }),
        );
        malformed = true;
        const result = yield* manager
          .restart(
            restartInput({ executionTargetId: target, cwd: "/work", shellSelection: selection }),
          )
          .pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        expect(adapter.processes[0]?.killSignals).toEqual([]);
        expect(adapter.spawnInputs).toHaveLength(1);
      }),
    );

    it.effect("failed processless explicit reopen preserves prior unknown transcript", () =>
      Effect.gen(function* () {
        const { manager, adapter, events } = yield* remoteFixture();
        yield* manager.open(
          openInput({ executionTargetId: target, cwd: "/work", shellSelection: selection }),
        );
        adapter.processes[0]!.emitData("retain on failed reopen\r\n");
        adapter.processes[0]!.emitExit({ exitCode: 0, signal: null });
        yield* waitFor(Effect.sync(() => events.some((event) => event.type === "exited")));
        const previous = yield* manager.snapshot(openInput());
        adapter.spawnFailures.push(new Error("EPERM"));
        const failed = yield* manager.open(
          openInput({ executionTargetId: target, cwd: "/work", shellSelection: selection }),
        );
        expect(failed.status).toBe("error");
        expect(failed.history).toBe(previous.history);
        expect(failed.history).toContain("retain on failed reopen");
      }),
    );

    it.effect("unknown dispatch retries use recovery without resolving fresh intent", () =>
      Effect.gen(function* () {
        const { manager, adapter, targets } = yield* remoteFixture();
        adapter.spawnFailures.push(new Error("connection outcome unknown"));
        yield* manager.open(
          openInput({ executionTargetId: target, cwd: "/work", shellSelection: selection }),
        );
        adapter.recovered = true;
        yield* manager.open(
          openInput({ executionTargetId: target, cwd: "/work", shellSelection: selection }),
        );
        expect(targets).toEqual([target]);
        expect(adapter.spawnInputs[1]?.recoverOnly).toBe(true);
        expect(adapter.spawnInputs[1]?.shellLaunch).toBeUndefined();
      }),
    );

    it.effect("explicit legacy-auto allows a separately requested new process", () =>
      Effect.gen(function* () {
        const { manager, adapter, targets } = yield* remoteFixture();
        yield* manager.open(
          openInput({ executionTargetId: target, cwd: "/work", shellSelection: selection }),
        );
        adapter.evidence = undefined;
        const next = yield* manager.restart(
          restartInput({
            executionTargetId: target,
            cwd: "/work",
            shellSelection: { kind: "legacy-auto" },
          }),
        );
        expect(next.status).toBe("running");
        expect(next.shellLaunchIdentity).toBeUndefined();
        expect(next.shellUnconfirmedLaunch).toBeUndefined();
        expect(adapter.spawnInputs[1]?.shellLaunch).toBeUndefined();
        expect(targets).toEqual([target]);
      }),
    );

    it.effect("preserves local implicit retry after an initial failed spawn", () =>
      Effect.gen(function* () {
        const { manager, ptyAdapter } = yield* createManager();
        ptyAdapter.spawnFailures.push(new Error("EPERM"));
        expect((yield* manager.open(openInput())).status).toBe("error");
        expect((yield* manager.open(openInput())).status).toBe("running");
      }),
    );

    it.effect(
      "legacy recovery never invents profile evidence and explicit mismatch cannot restart it",
      () =>
        Effect.gen(function* () {
          const { manager, adapter } = yield* remoteFixture(
            { resolveShellProfile: () => Effect.die("no rediscovery") },
            "old history",
          );
          adapter.evidence = undefined;
          adapter.recovered = true;
          const mismatched = yield* manager
            .open(openInput({ executionTargetId: target, cwd: "/work", shellSelection: selection }))
            .pipe(Effect.result);
          expect(mismatched._tag).toBe("Failure");
          const retained = yield* manager.snapshot(openInput());
          expect(retained.shellLaunchIdentity).toBeUndefined();
          expect(retained.shellUnconfirmedLaunch).toBeUndefined();
          expect(retained.history).toContain("old history");
          expect(adapter.spawnInputs).toHaveLength(1);
          expect(adapter.processes[0]?.killSignals).toEqual([]);
        }),
    );
  },
);
