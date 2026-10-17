import path from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Layer } from "effect";
import { expect, it, vi } from "vitest";
import { WS_METHODS, type TerminalEvent } from "@bigbud/contracts";
import { makeTerminalManagerWithOptions } from "../terminal/Layers/Manager";
import * as NodePTY from "../terminal/Layers/NodePTY";
import { PtyAdapter } from "../terminal/Services/PTY";
import { historyLogPath, waitFor } from "../terminal/Layers/Manager.test.helpers";
import { makeWsRpcGitTerminalHandlers } from "./wsRpcHandlers.gitTerminal";
import type { WsRpcContext } from "./wsRpcContext";

it.skipIf(process.platform === "win32")(
  "production RPC handlers and manager preserve a real PTY across snapshot recovery and grow/shrink",
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "bigbud-terminal-handoff-" });
          const shell = path.join(dir, "synthetic-tui");
          yield* fs.writeFileString(
            shell,
            `#!${process.execPath}\nprocess.stdin.setRawMode(true);\nconst report=()=>console.log('SIZE:'+process.stdout.columns+'x'+process.stdout.rows);\nprocess.stdout.on('resize',report);report();process.stdin.on('data',d=>console.log(d.toString()==='overflow'?'x'.repeat(1048577):'INPUT:'+d));\n`,
          );
          yield* fs.chmod(shell, 0o755);
          const adapter = yield* PtyAdapter;
          const spawn = vi.fn(adapter.spawn);
          const manager = yield* makeTerminalManagerWithOptions({
            logsDir: dir,
            ptyAdapter: { spawn },
            shellResolver: () => shell,
            agentDetector: () => Effect.succeed(new Map()),
            subprocessChecker: () => Effect.succeed(false),
          });
          const history = "\x1b[H\x1b[32mretained TUI frame\x1b[0m".repeat(20_000);
          yield* fs.writeFileString(historyLogPath(dir), history);
          const handlers = makeWsRpcGitTerminalHandlers({
            terminalManager: manager,
          } as WsRpcContext);
          const events: TerminalEvent[] = [];
          let responseReturned = false;
          const startedBeforeResponse: boolean[] = [];
          const unsubscribe = yield* manager.subscribe((event) =>
            Effect.sync(() => {
              events.push(event);
              if (event.type === "started") startedBeforeResponse.push(!responseReturned);
            }),
          );
          yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
          const input = {
            threadId: "thread-1",
            terminalId: "default",
            cwd: dir,
            cols: 80,
            rows: 24,
          };
          const opened = yield* handlers[WS_METHODS.terminalOpen](input);
          responseReturned = true;
          expect(startedBeforeResponse).toEqual([true]);
          const started = events.find((event) => event.type === "started");
          expect(started?.type === "started" && started.snapshot.history).toBe("");
          expect(opened.history).not.toContain("retained TUI frame");
          const output = () =>
            events
              .filter((event) => event.type === "output")
              .map((event) => event.data)
              .join("");
          for (const [cols, rows] of [
            [125, 37],
            [168, 49],
            [96, 24],
          ] as const) {
            yield* handlers[WS_METHODS.terminalResize]({
              threadId: input.threadId,
              terminalId: input.terminalId,
              cols,
              rows,
            });
            yield* Effect.promise(() => expect.poll(output).toContain(`SIZE:${cols}x${rows}`));
          }
          const recovered = yield* handlers[WS_METHODS.terminalSnapshot]({
            threadId: input.threadId,
            terminalId: input.terminalId,
          });
          expect(recovered.pid).toBe(opened.pid);
          expect(recovered.runtimeGeneration).toBe(opened.runtimeGeneration);
          expect(recovered.history).toContain("SIZE:96x24");
          expect(recovered.history).not.toContain("retained TUI frame");
          expect(spawn).toHaveBeenCalledOnce();
          yield* handlers[WS_METHODS.terminalWrite]({
            threadId: input.threadId,
            terminalId: input.terminalId,
            data: "fixture-only",
          });
          yield* Effect.promise(() => expect.poll(output).toContain("INPUT:fixture-only"));
          yield* handlers[WS_METHODS.terminalWrite]({ ...input, data: "overflow" });
          yield* waitFor(
            handlers[WS_METHODS.terminalSnapshot](input).pipe(
              Effect.map((snapshot) => snapshot.historyTruncated === true),
            ),
            "5 seconds",
          );
          const restarted = yield* handlers[WS_METHODS.terminalRestart](input);
          expect(restarted.pid).not.toBe(opened.pid);
          expect(restarted.runtimeGeneration).not.toBe(opened.runtimeGeneration);
          expect(restarted.historyTruncated).toBeUndefined();
          expect(restarted.historyUnavailable).toBeUndefined();
          yield* handlers[WS_METHODS.terminalWrite]({ ...input, data: "fresh-generation" });
          yield* Effect.promise(() => expect.poll(output).toContain("INPUT:fresh-generation"));
          yield* handlers[WS_METHODS.terminalClose]({
            threadId: input.threadId,
            terminalId: input.terminalId,
          });
          const result = yield* Effect.result(
            handlers[WS_METHODS.terminalSnapshot]({
              threadId: input.threadId,
              terminalId: input.terminalId,
            }),
          );
          expect(result._tag).toBe("Failure");
          expect(spawn).toHaveBeenCalledTimes(2);
        }).pipe(Effect.provide(NodePTY.layer.pipe(Layer.provideMerge(NodeServices.layer)))),
      ),
    );
  },
);
