import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { expect } from "vitest";
import { TerminalEvent, TerminalSessionSnapshot } from "@bigbud/contracts/workspace/terminal.ts";
import {
  createTerminalAgentDetector,
  parsePosixAgentProcesses,
  TerminalAgentInspectionError,
} from "./Manager.agentDetection.ts";
import {
  createManager,
  FakePtyAdapter,
  openInput,
  restartInput,
  waitFor,
} from "./Manager.test.helpers.ts";
import { makeTerminalTitleListener } from "../../orchestration/Layers/TerminalThreadTitleReactor.ts";

const fictional = {
  id: "nebula-worker",
  names: ["Nebula Worker"],
  executables: ["nebula-worker"],
  scriptPaths: ["/nebula-worker/"],
};
const transportEvent = (event: TerminalEvent) =>
  Schema.decodeUnknownSync(TerminalEvent)(JSON.parse(JSON.stringify(event)));

it.layer(NodeServices.layer, { excludeTestServices: true })(
  "generic terminal identity pipeline",
  (it) => {
    for (const command of ["nebula-worker", "node /modules/nebula-worker/cli.js"]) {
      it.effect(
        `carries ${command} through real detection, manager transport and unmarked task naming`,
        () =>
          Effect.gen(function* () {
            const ptyAdapter = new FakePtyAdapter();
            const detector = createTerminalAgentDetector({
              agents: [fictional],
              inspect: () =>
                Effect.sync(() => ({
                  platform: "posix" as const,
                  processes: parsePosixAgentProcesses(
                    ptyAdapter.processes
                      .filter((process) => !process.killed)
                      .map(
                        (process) =>
                          `${process.pid} 1 ${process.pid} ${process.pid + 10000} /bin/zsh\n${process.pid + 10000} ${process.pid} ${process.pid + 10000} ${process.pid + 10000} ${command}`,
                      )
                      .join("\n"),
                  ),
                })),
            });
            const { manager, getEvents } = yield* createManager(50, {
              ptyAdapter,
              agentDetector: detector,
              subprocessChecker: () => Effect.succeed(true),
              subprocessPollIntervalMs: 20,
            });
            const titles: string[] = [];
            // No fictional adapter is passed to the title listener: evidence must arrive over transport.
            const listener = makeTerminalTitleListener({
              dispatch: (command) =>
                Effect.sync(() => {
                  if (command.type === "thread.meta.update" && command.title)
                    titles.push(command.title);
                  return { sequence: titles.length };
                }),
            });
            const opened = yield* manager.open(openInput());
            yield* waitFor(
              Effect.map(getEvents, (events) =>
                events.some(
                  (event) => event.type === "agentIdentity" && event.agent?.id === fictional.id,
                ),
              ),
              "1200 millis",
            );
            const snapshot = Schema.decodeUnknownSync(TerminalSessionSnapshot)(
              JSON.parse(JSON.stringify(yield* manager.snapshot(openInput()))),
            );
            expect(snapshot.activeAgent).toEqual({ id: fictional.id, names: fictional.names });
            expect(snapshot.activeAgentProvider).toBeNull();
            if (command.startsWith("node "))
              yield* listener({
                type: "started",
                threadId: opened.threadId,
                terminalId: opened.terminalId,
                snapshot,
                createdAt: snapshot.updatedAt,
              });
            const unsubscribe = yield* manager.subscribe((event) =>
              command.startsWith("node ") && event.type === "agentIdentity"
                ? Effect.void
                : listener(transportEvent(event)),
            );
            yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
            ptyAdapter.processes[0]!.emitData("\x1b]2;Nebula Worker\x07\x1b]2;git status\x07");
            yield* waitFor(
              Effect.map(getEvents, (events) => events.some((event) => event.type === "output")),
              "1200 millis",
            );
            expect(titles).toEqual([]);
            ptyAdapter.processes[0]!.emitData("\x1b]2;Review authentication flow\x07");
            yield* waitFor(
              Effect.sync(() => titles.length === 1),
              "1200 millis",
            );
            expect(titles).toEqual(["Review authentication flow"]);
            const identity = (yield* getEvents).find(
              (event) => event.type === "agentIdentity" && event.agent?.id === fictional.id,
            );
            expect(identity).toMatchObject({
              provider: null,
              agent: { id: fictional.id, names: fictional.names },
            });
            ptyAdapter.processes[0]!.emitExit({ exitCode: 0, signal: 0 });
            yield* waitFor(
              Effect.map(getEvents, (events) => events.some((event) => event.type === "exited")),
              "1200 millis",
            );
            const replay: TerminalEvent[] = [];
            const detach = yield* manager.subscribe((event) =>
              Effect.sync(() => {
                replay.push(transportEvent(event));
              }),
            );
            expect(replay.at(-1)).toMatchObject({
              type: "agentIdentity",
              provider: null,
              agent: null,
            });
            detach();
          }),
      );
    }

    it.effect(
      "preserves generic identity on scan failure, then clears it at the shell and on restart",
      () =>
        Effect.gen(function* () {
          const ptyAdapter = new FakePtyAdapter();
          let command = "nebula-worker";
          let fails = false;
          let failedScans = 0;
          const detector = createTerminalAgentDetector({
            agents: [fictional],
            inspect: () =>
              Effect.suspend(() => {
                if (fails) {
                  failedScans++;
                  return Effect.fail(
                    new TerminalAgentInspectionError({ message: "scan unavailable" }),
                  );
                }
                return Effect.succeed({
                  platform: "posix" as const,
                  processes: parsePosixAgentProcesses(
                    ptyAdapter.processes
                      .filter((process) => !process.killed)
                      .map(
                        (process) =>
                          `${process.pid} 1 ${process.pid} ${process.pid + 10000} /bin/zsh\n${process.pid + 10000} ${process.pid} ${process.pid + 10000} ${process.pid + 10000} ${command}`,
                      )
                      .join("\n"),
                  ),
                });
              }),
          });
          const { manager, getEvents } = yield* createManager(50, {
            ptyAdapter,
            agentDetector: detector,
            subprocessChecker: () => Effect.succeed(true),
            subprocessPollIntervalMs: 20,
          });
          yield* manager.open(openInput());
          yield* waitFor(
            Effect.map(getEvents, (events) =>
              events.some(
                (event) => event.type === "agentIdentity" && event.agent?.id === fictional.id,
              ),
            ),
            "1200 millis",
          );
          fails = true;
          yield* waitFor(
            Effect.sync(() => failedScans >= 3),
            "1200 millis",
          );
          expect((yield* manager.snapshot(openInput())).activeAgent?.id).toBe(fictional.id);
          fails = false;
          command = "unregistered-mystery-agent";
          yield* waitFor(
            Effect.map(getEvents, (events) =>
              events.some((event) => event.type === "agentIdentity" && event.agent === null),
            ),
            "1200 millis",
          );
          expect((yield* manager.snapshot(openInput())).activeAgent).toBeNull();
          command = "nebula-worker";
          yield* waitFor(
            manager
              .snapshot(openInput())
              .pipe(Effect.map((snapshot) => snapshot.activeAgent?.id === fictional.id)),
            "1200 millis",
          );
          command = "unregistered-mystery-agent";
          const restarted = yield* manager.restart(restartInput());
          expect(restarted.activeAgent).toBeNull();
          expect(restarted.activeAgentProvider).toBeNull();
        }),
    );
  },
);
