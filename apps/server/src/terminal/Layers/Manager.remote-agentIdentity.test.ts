import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Deferred, Effect } from "effect";
import { expect, vi } from "vitest";
import type { TerminalEvent } from "@bigbud/contracts/workspace/terminal.ts";
import type { PtySpawnInput } from "../Services/PTY.ts";
import {
  parsePosixAgentProcesses,
  TerminalAgentInspectionError,
} from "./Manager.agentDetection.ts";
import { inspectRemoteTerminalProcesses } from "./Manager.remote-inspection.ts";
import { remoteShellPidPrefix } from "./Manager.remote-identity.ts";
import {
  createManager,
  FakePtyAdapter,
  openInput,
  restartInput,
  waitFor,
} from "./Manager.test.helpers.ts";
import { makeTerminalTitleListener } from "../../orchestration/Layers/TerminalThreadTitleReactor.ts";

vi.mock("./Manager.remote-inspection.ts", () => ({ inspectRemoteTerminalProcesses: vi.fn() }));
vi.mock("../../ssh/sshProcess.ts", () => ({
  runSshCommand: vi.fn(async (input: { args: string[] }) => ({
    stdout: `\x1e${input.args[3]}\x1f`,
    stderr: "",
    code: 0,
    signal: null,
    timedOut: false,
  })),
}));
const target = "ssh:host=devbox&user=deploy&auth=ssh-key";

class RemoteFakeAdapter extends FakePtyAdapter {
  override spawn(input: PtySpawnInput) {
    return super.spawn(input).pipe(
      Effect.map((process) =>
        Object.assign(process, {
          pidDomain: "remote" as const,
          recovered: true,
        }),
      ),
    );
  }
}

it.layer(NodeServices.layer, { excludeTestServices: true })("remote identity lifecycle", (it) => {
  it.effect("does not stall local identity polling while a remote probe is pending", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const adapter = new RemoteFakeAdapter();
      let localProvider: "pi" | "codex" = "pi";
      const { manager } = yield* createManager(50, {
        ptyAdapter: adapter,
        subprocessPollIntervalMs: 20,
        subprocessChecker: () => Effect.succeed(false),
        remoteProcessInspector: () =>
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
        agentDetector: (pids) => Effect.succeed(new Map(pids.map((pid) => [pid, localProvider]))),
      });
      const local = openInput({ terminalId: "local" });
      yield* manager.open(local);
      yield* manager.open(openInput({ executionTargetId: target, cwd: "/project" }));
      yield* Deferred.await(started);
      yield* waitFor(
        manager.snapshot(local).pipe(Effect.map((value) => value.activeAgentProvider === "pi")),
      );
      localProvider = "codex";
      yield* waitFor(
        manager.snapshot(local).pipe(Effect.map((value) => value.activeAgentProvider === "codex")),
      );
    }),
  );
  for (const mode of ["direct-ssh", "restored-agent"] as const) {
    it.effect(
      `${mode}: generic identities, provider changes, replay/snapshot, title, exit and restart`,
      () =>
        Effect.gen(function* () {
          const adapter = mode === "direct-ssh" ? new FakePtyAdapter() : new RemoteFakeAdapter();
          let command = "gemini";
          let fails = false;
          let scans = 0;
          vi.mocked(inspectRemoteTerminalProcesses).mockImplementation(() =>
            Effect.suspend(() => {
              scans++;
              if (fails)
                return Effect.fail(new TerminalAgentInspectionError({ message: "offline" }));
              return Effect.succeed(
                parsePosixAgentProcesses(
                  adapter.processes
                    .map((process) => {
                      const pid = mode === "direct-ssh" ? process.pid + 10000 : process.pid;
                      const fg = command ? pid + 50000 : pid;
                      return (
                        `${pid} 1 ${pid} ${fg} /bin/zsh` +
                        (command ? `\n${fg} ${pid} ${fg} ${fg} ${command}` : "")
                      );
                    })
                    .join("\n"),
                ),
              );
            }),
          );
          const localPids: number[] = [];
          const { manager, getEvents } = yield* createManager(50, {
            ptyAdapter: adapter,
            remoteProcessInspector: inspectRemoteTerminalProcesses,
            subprocessPollIntervalMs: 20,
            subprocessChecker: (pid) =>
              Effect.sync(() => {
                localPids.push(pid);
                return false;
              }),
            agentDetector: (pids) =>
              Effect.sync(() => {
                localPids.push(...pids);
                return new Map();
              }),
          });
          const input = openInput({ executionTargetId: target, cwd: "/project" });
          const opened = yield* manager.open(input);
          const publishPid = (generation: string, index: number) => {
            if (mode === "direct-ssh") {
              const process = adapter.processes[index]!;
              const marker = `${remoteShellPidPrefix(generation)}${process.pid + 10000}\x07`;
              process.emitData(marker.slice(0, 12));
              process.emitData(marker.slice(12) + "ready\r\n");
            }
          };
          publishPid(opened.runtimeGeneration!, 0);
          yield* waitFor(
            manager.snapshot(input).pipe(Effect.map((value) => value.activeAgent?.id === "gemini")),
            "1200 millis",
          );
          const current = yield* manager.snapshot(input);
          expect(current.activeAgentProvider).toBeNull();
          expect(current.activeAgent).toEqual({ id: "gemini", names: ["Gemini", "Gemini CLI"] });
          expect(current.history).not.toContain("bigbud-shell-");
          expect(current.historyUnavailable).toBe(mode === "restored-agent" ? true : undefined);
          expect(localPids).toEqual([]);
          const replay: TerminalEvent[] = [];
          const detach = yield* manager.subscribe((event) =>
            Effect.sync(() => {
              replay.push(event);
            }),
          );
          expect(replay.at(-1)).toMatchObject({
            type: "agentIdentity",
            provider: null,
            agent: { id: "gemini" },
          });
          detach();
          const titles: string[] = [];
          const titleListener = makeTerminalTitleListener({
            dispatch: (command) =>
              Effect.sync(() => {
                if (command.type === "thread.meta.update" && command.title)
                  titles.push(command.title);
                return { sequence: titles.length };
              }),
          });
          const removeTitle = yield* manager.subscribe(titleListener);
          adapter.processes[0]!.emitData("\x1b]2;Review remote authentication\x07");
          yield* waitFor(
            Effect.sync(() => titles.length === 1),
            "1200 millis",
          );
          expect(titles).toEqual(["Review remote authentication"]);
          removeTitle();
          fails = true;
          const priorScans = scans;
          yield* waitFor(
            Effect.sync(() => scans >= priorScans + 3),
            "1200 millis",
          );
          expect((yield* manager.snapshot(input)).activeAgent?.id).toBe("gemini");
          fails = false;
          command = "codex";
          yield* waitFor(
            manager
              .snapshot(input)
              .pipe(Effect.map((value) => value.activeAgentProvider === "codex")),
            "1200 millis",
          );
          command = "pi";
          yield* waitFor(
            manager.snapshot(input).pipe(Effect.map((value) => value.activeAgentProvider === "pi")),
            "1200 millis",
          );
          command = "";
          yield* waitFor(
            manager.snapshot(input).pipe(Effect.map((value) => value.activeAgent === null)),
            "1200 millis",
          );
          command = "codex";
          yield* waitFor(
            manager
              .snapshot(input)
              .pipe(Effect.map((value) => value.activeAgentProvider === "codex")),
            "1200 millis",
          );
          fails = true; // PTY exit clears identity even while inspection is unavailable.
          adapter.processes[0]!.emitExit({ exitCode: 0, signal: null });
          yield* waitFor(
            getEvents.pipe(Effect.map((events) => events.some((event) => event.type === "exited"))),
            "1200 millis",
          );
          const afterExit: TerminalEvent[] = [];
          const detachExit = yield* manager.subscribe((event) =>
            Effect.sync(() => {
              afterExit.push(event);
            }),
          );
          expect(afterExit.at(-1)).toMatchObject({
            type: "agentIdentity",
            provider: null,
            agent: null,
          });
          detachExit();
          fails = false;
          command = "gemini";
          const restarted = yield* manager.restart(
            restartInput({ executionTargetId: target, cwd: "/project" }),
          );
          expect(restarted.activeAgent).toBeNull();
          expect(restarted.runtimeGeneration).not.toBe(opened.runtimeGeneration);
          publishPid(restarted.runtimeGeneration!, 1);
          yield* waitFor(
            manager.snapshot(input).pipe(Effect.map((value) => value.activeAgent?.id === "gemini")),
            "1200 millis",
          );
          expect(localPids).toEqual([]);
        }),
    );
  }
});
