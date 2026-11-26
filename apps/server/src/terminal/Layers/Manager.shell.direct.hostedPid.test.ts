/**
 * M7 follow-up: a hosted Direct SSH record stores the remote shell PID printed at launch, so a PTY
 * reattached after a backend restart still gets real owner busy hints instead of `unknown`.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { expect, vi } from "vitest";

import { fixture } from "../../persistence/Layers/DirectShellLaunchOwners.test.helpers";
import { parsePosixAgentProcesses } from "./Manager.agentDetection.ts";
import { directShellOwnerKey } from "./DirectShellLaunch.owner";
import { hostedDirectShellOwner } from "./DirectShellLaunch.hosted";
import { historyPath } from "./Manager.history-io.ts";
import { flush, makeHostManager } from "./Manager.host.test.helpers.ts";
import { remoteShellPidPrefix } from "./Manager.remote-identity.ts";
import { trackHostedDirectShellRecord } from "./Manager.shell.direct.hostedPid.ts";
import {
  DirectSshHostAdapter,
  SSH_TARGET,
  sshPane,
} from "./Manager.shell.direct.hosted.test.helpers.ts";
import { FakePtyProcess } from "./Manager.test.helpers.ts";

vi.mock("../../ssh/sshProcess", () => ({
  runSshCommand: vi.fn(async (input: { args: string[] }) => ({
    stdout: `\x1e${input.args[3]}\x1f`,
    stderr: "",
    code: 0,
    signal: null,
    timedOut: false,
  })),
}));

const key = directShellOwnerKey("thread-1", "ssh");
const generationOf = (args: ReadonlyArray<string> | undefined) =>
  /bigbud-shell-([0-9a-f-]{36})/.exec((args ?? []).join(" "))?.[1];
const waitFor = async (check: () => boolean | Promise<boolean>) => {
  for (let attempt = 0; attempt < 100 && !(await check()); attempt++) await flush();
};

it.layer(NodeServices.layer, { excludeTestServices: true })(
  "hosted Direct SSH remote shell PID",
  (it) => {
    it.effect("stores the launch PID and restores real busy hints after a restart", () =>
      Effect.gen(function* () {
        const db = yield* Effect.promise(fixture);
        const adapter = new DirectSshHostAdapter();
        const inspector = vi.fn((_target: string) =>
          Effect.succeed(parsePosixAgentProcesses("4242 1 4242 4242 -zsh")),
        );
        const options = {
          directShellOwners: db.store,
          remoteProcessInspector: inspector,
          subprocessPollIntervalMs: 20,
        };
        const first = yield* makeHostManager(adapter, options);
        yield* first.manager.open(sshPane());
        const process = yield* adapter.processAt(0);
        const generation = generationOf(adapter.hostSpawns()[0]?.args);
        expect(generation).toBeDefined();
        process.emitHost(`${remoteShellPidPrefix(generation!)}4242\x07me@devbox$ `);
        yield* Effect.promise(() =>
          waitFor(async () => (await db.store.getHosted!(key))?.remoteShellPid === 4242),
        );
        expect((yield* Effect.promise(() => db.store.getHosted!(key)))?.remoteShellPid).toBe(4242);

        // A second backend over the same host and journal reattaches the same PTY, which never
        // prints its marker again: only the stored PID can give it a real hint.
        inspector.mockClear();
        Object.assign(process, { recovered: true });
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(historyPath(first.logsDir, "thread-1", "ssh"), "me@devbox$ ");
        const restarted = yield* makeHostManager(adapter, { ...options, logsDir: first.logsDir });
        yield* restarted.manager.open(sshPane({ attachOnly: true }));
        expect(adapter.spawnInputs.at(-1)).toMatchObject({ recoverOnly: true });
        expect(adapter.processes).toHaveLength(1);
        yield* Effect.promise(() =>
          waitFor(() => process.viewStates.at(-1)?.ownerBusyHint === "idle"),
        );
        expect(inspector).toHaveBeenCalledWith(SSH_TARGET);
        expect(process.viewStates.at(-1)?.ownerBusyHint).toBe("idle");
      }),
    );

    it.effect("clears a stale PID when a fresh PTY starts under a kept record", () =>
      Effect.gen(function* () {
        const db = yield* Effect.promise(fixture);
        const stored = (yield* Effect.promise(() =>
          db.store.reserveHosted!(
            hostedDirectShellOwner({
              threadId: "thread-1",
              terminalId: "ssh",
              executionTargetId: SSH_TARGET,
            }),
          ),
        )).owner;
        const withPid = yield* Effect.promise(() => db.store.setHostedRemoteShellPid!(stored, 77));
        expect(withPid?.remoteShellPid).toBe(77);
        // A stale copy changes nothing.
        expect(
          yield* Effect.promise(() => db.store.setHostedRemoteShellPid!(stored, 78)),
        ).toBeUndefined();

        const process = new FakePtyProcess(1);
        const session = { runtimeGeneration: "00000000-0000-4000-8000-000000000000" };
        const store = {
          releaseHosted: db.store.releaseHosted!,
          setHostedRemoteShellPid: db.store.setHostedRemoteShellPid!,
        };
        trackHostedDirectShellRecord({ store, record: withPid!, process, session });
        yield* Effect.promise(() =>
          waitFor(async () => (await db.store.getHosted!(key))?.remoteShellPid === undefined),
        );
        expect((yield* Effect.promise(() => db.store.getHosted!(key)))?.remoteShellPid).toBe(
          undefined,
        );
        process.emitData(`${remoteShellPidPrefix(session.runtimeGeneration)}900\x07`);
        yield* Effect.promise(() =>
          waitFor(async () => (await db.store.getHosted!(key))?.remoteShellPid === 900),
        );
        // The exit releases the latest copy, not the one the tracker started with.
        process.emitExit({ exitCode: 0, signal: null });
        yield* Effect.promise(() =>
          waitFor(async () => (await db.store.getHosted!(key)) === undefined),
        );
        expect(yield* Effect.promise(() => db.store.getHosted!(key))).toBeUndefined();
      }),
    );

    it.effect("a reattached PTY takes the stored PID; an interrupted one keeps its record", () =>
      Effect.gen(function* () {
        const record = {
          ...hostedDirectShellOwner({
            threadId: "thread-1",
            terminalId: "ssh",
            executionTargetId: SSH_TARGET,
          }),
          remoteShellPid: 55,
        };
        const process = Object.assign(new FakePtyProcess(1), {
          recovered: true,
          interruptionReason: "host-unreachable",
        });
        const session: { runtimeGeneration: string; remoteShellPid?: number | undefined } = {
          runtimeGeneration: "g",
        };
        const releaseHosted = vi.fn(async () => true);
        trackHostedDirectShellRecord({ store: { releaseHosted }, record, process, session });
        expect(session.remoteShellPid).toBe(55);
        process.emitExit({ exitCode: 1, signal: null });
        yield* Effect.promise(flush);
        expect(releaseHosted).not.toHaveBeenCalled();
      }),
    );
  },
);
