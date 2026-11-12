// Simulate sessions admitted by the previous build; production admission is tested separately.
vi.mock("./Manager.shell.direct.policy", async (original) => ({
  ...(await original<typeof import("./Manager.shell.direct.policy")>()),
  assertDirectShellProfileEnabled: () => undefined,
}));
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
import { fixture, intent, prepared } from "./DirectShellLaunch.dispatch.test.helpers";
import { directShellOwnerKey } from "./DirectShellLaunch.owner";
import { remoteFixture } from "./Manager.shell.remote.test.helpers";
import { FakePtyAdapter, openInput, restartInput, waitFor } from "./Manager.test.helpers";
import { resolveShellProfileLaunch } from "./ShellProfiles.launch";
import type { TerminalManagerOptions } from "./Manager.types";

const storedIntent = intent();
const target = storedIntent.executionTargetId;
const requested = storedIntent.launch.requestedProfile;
const profile = {
  ...requested,
  executable: storedIntent.launch.executable,
  args: storedIntent.launch.args,
  platform: "linux" as const,
  displayName: "zsh",
  availability: "available" as const,
  integration: { status: "disabled" as const },
};
const selection = { kind: "profile" as const, profileId: profile.profileId };
const ownerKey = directShellOwnerKey("thread-1", "default");
const input = { executionTargetId: target, cwd: "/work", shellSelection: selection };

function setup(options: Partial<TerminalManagerOptions> = {}) {
  const journal = fixture();
  const adapter = new FakePtyAdapter();
  const create = () =>
    remoteFixture({
      ptyAdapter: adapter,
      directShellOwners: journal.store,
      resolveShellProfile: (selected) =>
        Effect.succeed(
          resolveShellProfileLaunch({
            host: profile.host,
            profiles: [profile],
            selection: selected,
          }),
        ),
      ...options,
    });
  return { ...journal, adapter, create };
}

it.layer(NodeServices.layer, { excludeTestServices: true })("direct Manager profiles", (it) => {
  it.effect(
    "close and retry preserve running direct owner, history and lease; EOF is not release",
    () =>
      Effect.gen(function* () {
        const release = vi.fn(() => Effect.void);
        const test = setup({ releaseWorktreeLease: release });
        const { manager, events } = yield* test.create();
        const opened = yield* manager.open(openInput(input));
        const owner = test.entries.get(ownerKey);
        const close = () =>
          manager
            .close({
              threadId: "thread-1",
              terminalId: "default",
              deleteHistory: true,
              expectedGeneration: opened.runtimeGeneration,
            })
            .pipe(Effect.result);
        for (let attempt = 0; attempt < 2; attempt++) {
          const result = yield* close();
          expect(result._tag).toBe("Failure");
          if (result._tag === "Failure")
            expect(result.failure).toMatchObject({ reason: "directShellUnconfirmed" });
          expect((yield* manager.snapshot(openInput())).status).toBe("running");
        }
        expect(test.adapter.processes[0]!.killSignals).toEqual([]);
        expect(test.entries.get(ownerKey)).toEqual(owner);
        expect(release).not.toHaveBeenCalled();
        test.adapter.processes[0]!.emitExit({ exitCode: 0, signal: null });
        yield* waitFor(Effect.sync(() => events.some((event) => event.type === "exited")));
        expect((yield* manager.snapshot(openInput())).status).toBe("exited");
        expect((yield* close())._tag).toBe("Failure");
        expect((yield* manager.snapshot(openInput())).status).toBe("exited");
        expect(test.entries.get(ownerKey)).toEqual(owner);
        expect(release).not.toHaveBeenCalled();
        const recovered = yield* test.create();
        expect(
          (yield* recovered.manager
            .close({ threadId: "thread-1", terminalId: "default", deleteHistory: true })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(test.entries.get(ownerKey)).toEqual(owner);
      }),
  );

  it.effect(
    "reserves before exact SSH dispatch and publishes requested, never actual identity",
    () =>
      Effect.gen(function* () {
        const test = setup();
        const { manager, events } = yield* test.create();
        const opened = yield* manager.open(openInput(input));
        expect(opened.status).toBe("running");
        expect(opened.shellLaunchIdentity).toBeUndefined();
        expect(opened.shellUnconfirmedLaunch).toEqual({
          status: "unconfirmed",
          requestedProfile: requested,
        });
        expect(test.entries.get(ownerKey)?.state).toBe("may-have-been-sent");
        const dispatched = test.adapter.spawnInputs[0]!;
        expect(dispatched.shell).toBe("ssh");
        expect(dispatched.args?.join(" ")).toContain(profile.executable);
        expect(dispatched.executionTargetId).toBeUndefined();
        expect(dispatched.cwd).not.toBe("/work");
        expect(dispatched.shellLaunch).toBeUndefined();
        const started = events.find((event) => event.type === "started");
        expect(started?.type === "started" && started.snapshot.shellUnconfirmedLaunch).toEqual(
          opened.shellUnconfirmedLaunch,
        );
        test.adapter.processes[0]!.emitData(
          `\x1b]777;bigbud-shell-${opened.runtimeGeneration};4321\x07visible output\r\n`,
        );
        yield* waitFor(
          manager
            .snapshot(openInput())
            .pipe(Effect.map((snapshot) => snapshot.history.includes("visible output"))),
        );
        expect((yield* manager.snapshot(openInput())).history).not.toContain("bigbud-shell-");
        const again = yield* manager.open(openInput(input));
        expect(again.runtimeGeneration).toBe(opened.runtimeGeneration);
        expect(test.adapter.spawnInputs).toHaveLength(1);
        expect(test.store.reserve).toHaveBeenCalledTimes(1);
      }),
  );

  for (const destination of [
    input,
    { ...input, shellSelection: { kind: "legacy-auto" as const } },
    {
      executionTargetId: "local",
      cwd: "/tmp",
      shellSelection: { kind: "legacy-auto" as const },
    },
  ]) {
    it.effect(
      `refuses replacement before stop, including target/policy bypass ${destination.executionTargetId}/${destination.shellSelection.kind}`,
      () =>
        Effect.gen(function* () {
          const test = setup();
          const { manager } = yield* test.create();
          const opened = yield* manager.open(openInput(input));
          const refused = yield* manager
            .restart(restartInput({ ...destination, expectedGeneration: opened.runtimeGeneration }))
            .pipe(Effect.result);
          expect(refused._tag).toBe("Failure");
          if (refused._tag === "Failure")
            expect(refused.failure).toMatchObject({ reason: "restartNotStarted" });
          expect(test.adapter.processes[0]?.killSignals).toEqual([]);
          expect(test.adapter.spawnInputs).toHaveLength(1);
          expect((yield* manager.snapshot(openInput())).runtimeGeneration).toBe(
            opened.runtimeGeneration,
          );
          yield* manager.write({
            threadId: "thread-1",
            terminalId: "default",
            data: "ordinary input",
            expectedGeneration: opened.runtimeGeneration,
          });
          expect(test.adapter.processes[0]?.writes).toContain("ordinary input");
        }),
    );
  }

  it.effect(
    "transport EOF retains ownership and blocks explicit or legacy processless reopen",
    () =>
      Effect.gen(function* () {
        const test = setup();
        const { manager, events } = yield* test.create();
        yield* manager.open(openInput(input));
        test.adapter.processes[0]!.emitExit({ exitCode: 0, signal: null });
        yield* waitFor(Effect.sync(() => events.some((event) => event.type === "exited")));
        for (const shellSelection of [selection, { kind: "legacy-auto" as const }]) {
          const result = yield* manager
            .open(openInput({ ...input, shellSelection }))
            .pipe(Effect.result);
          expect(result._tag).toBe("Failure");
        }
        expect(test.entries.get(ownerKey)?.state).toBe("may-have-been-sent");
        expect(test.adapter.spawnInputs).toHaveLength(1);
        expect(test.store.cancelPrepared).not.toHaveBeenCalled();
      }),
  );

  it.effect("uncertain spawn retains its fence across a new controller and never falls back", () =>
    Effect.gen(function* () {
      const test = setup();
      test.adapter.spawnFailures.push(new Error("transport outcome unknown"));
      const first = yield* test.create();
      expect((yield* first.manager.open(openInput(input))).status).toBe("error");
      expect(test.entries.get(ownerKey)?.state).toBe("outcome-unknown");
      const second = yield* test.create();
      const result = yield* second.manager.open(openInput(input)).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect(test.adapter.spawnInputs).toHaveLength(1);
      expect(test.store.reserve).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("only explicit replacement can recover an undispatched prepared reservation", () =>
    Effect.gen(function* () {
      const test = setup();
      test.entries.set(ownerKey, { ...prepared(), ownerKey });
      vi.mocked(test.store.cancelPrepared).mockImplementation(
        async (key, reservation, controller) => {
          const owner = test.entries.get(key);
          if (
            owner?.state !== "prepared" ||
            owner.reservationId !== reservation ||
            owner.controllerId !== controller
          )
            return false;
          return test.entries.delete(key);
        },
      );
      const { manager } = yield* test.create();
      const blocked = yield* manager.open(openInput(input)).pipe(Effect.result);
      expect(blocked._tag).toBe("Failure");
      expect(test.store.cancelPrepared).not.toHaveBeenCalled();
      expect(test.adapter.spawnInputs).toHaveLength(0);
      const recovered = yield* manager.restart(restartInput(input));
      expect(recovered.status).toBe("running");
      expect(recovered.shellUnconfirmedLaunch?.requestedProfile).toEqual(requested);
      expect(test.store.cancelPrepared).toHaveBeenCalledTimes(1);
      expect(test.entries.get(ownerKey)?.reservationId).not.toBe("old-reservation");
      expect(test.entries.get(ownerKey)?.state).toBe("may-have-been-sent");
      expect(test.adapter.spawnInputs).toHaveLength(1);
    }),
  );

  it.effect("legacy replacement preflights exact intent before stopping and dispatches once", () =>
    Effect.gen(function* () {
      const test = setup();
      const { manager } = yield* test.create();
      yield* manager.open(openInput({ ...input, shellSelection: { kind: "legacy-auto" } }));
      const replacement = yield* manager.restart(restartInput(input));
      expect(replacement.status).toBe("running");
      expect(replacement.shellLaunchIdentity).toBeUndefined();
      expect(replacement.shellUnconfirmedLaunch?.requestedProfile).toEqual(requested);
      expect(test.adapter.processes[0]?.killSignals.length).toBeGreaterThan(0);
      expect(test.adapter.spawnInputs).toHaveLength(2);
      expect(test.store.claimDispatch).toHaveBeenCalledTimes(1);
    }),
  );
});
