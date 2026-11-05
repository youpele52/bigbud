import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { it } from "@effect/vitest";
import { beforeEach, afterEach, expect, vi } from "vitest";
import { createManager, openInput } from "./Manager.test.helpers";
import { makeWsRpcTerminalSessionHandlers } from "../../ws/wsRpcHandlers.terminalSession";
import type { WsRpcContext } from "../../ws/wsRpcContext";
import { WS_METHODS } from "@bigbud/contracts";

beforeEach(() => vi.stubEnv("BIGBUD_TERMINAL_RECOVERY_SHADOW", "1"));
afterEach(() => vi.unstubAllEnvs());

it.layer(NodeServices.layer, { excludeTestServices: true })("recovery RPC cuts", (it) => {
  it.effect(
    "returns a fixed applied cut and lossless ordered resize/output suffix without PTY replies",
    () =>
      Effect.gen(function* () {
        const { manager, ptyAdapter } = yield* createManager();
        const input = openInput();
        const opened = yield* manager.open(input);
        const request = {
          threadId: input.threadId,
          terminalId: input.terminalId!,
          expectedGeneration: opened.runtimeGeneration!,
        };
        const rpc = makeWsRpcTerminalSessionHandlers({ terminalManager: manager } as WsRpcContext)[
          WS_METHODS.terminalRecovery
        ];
        const run = Effect.runPromiseWith(yield* Effect.services());
        const process = ptyAdapter.processes[0]!;
        process.emitData("before");
        const cut = yield* Effect.promise(async () => {
          const pending = run(rpc(request));
          await run(manager.resize({ ...input, cols: 90, rows: 30 }));
          process.emitData("after\x1b[6n");
          return pending;
        });
        expect(cut.type).toBe("snapshot");
        if (cut.type !== "snapshot") return;
        expect(cut.frame).toMatchObject({ cols: 100, rows: 24, sequence: 1 });
        expect(cut.frame.ansi).toContain("before");
        expect(cut.frame.ansi).not.toContain("after");
        yield* Effect.promise(() =>
          expect
            .poll(async () => {
              const suffix = await run(rpc({ ...request, after: cut.frame }));
              return suffix.type === "suffix"
                ? suffix.records.map((record) => record.type)
                : suffix.type;
            })
            .toEqual(["resize", "output"]),
        );
        const suffix = yield* rpc({ ...request, after: cut.frame });
        expect(suffix.type === "suffix" && suffix.through.sequence).toBe(3);
        expect(process.writes).toEqual([]);
        expect(ptyAdapter.processes).toHaveLength(1);
        const stale = yield* rpc({ ...request, expectedGeneration: "stale" });
        expect(stale).toEqual({ type: "unavailable", reason: "generation-mismatch" });
        yield* manager.restart({ ...input, cols: 100, rows: 24 });
        expect(yield* rpc(request)).toEqual({ type: "unavailable", reason: "generation-mismatch" });
      }),
  );

  it.effect("preserves a running process when snapshot profile is unsupported", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      const input = openInput();
      const opened = yield* manager.open(input);
      ptyAdapter.processes[0]!.emitData("\x1b(A\x1b7unsupported");
      const result = yield* manager.recovery!({
        threadId: input.threadId,
        terminalId: input.terminalId!,
        expectedGeneration: opened.runtimeGeneration!,
      });
      expect(result).toEqual({ type: "unavailable", reason: "saved-cursor-not-qualified" });
      expect((yield* manager.snapshot(input)).pid).toBe(opened.pid);
      yield* manager.write({ ...input, data: "input-still-works" });
      expect(ptyAdapter.processes[0]!.writes).toEqual(["input-still-works"]);
      expect(ptyAdapter.processes).toHaveLength(1);
    }),
  );
});
