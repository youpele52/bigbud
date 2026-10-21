import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import type { TerminalEvent } from "@bigbud/contracts";
import { Effect } from "effect";
import { expect, vi } from "vitest";

import { createManager, openInput, restartInput, waitFor } from "./Manager.test.helpers";

vi.mock("../../ssh/sshProcess", () => ({
  runSshCommand: vi.fn(async (input: { args: string[] }) => ({
    stdout: `\x1e${input.args[3]}\x1f`,
    stderr: "",
    code: 0,
    signal: null,
    timedOut: false,
  })),
}));

const REMOTE_TARGET = "ssh:host=devbox&user=root&port=22&auth=ssh-key";

it.layer(NodeServices.layer, { excludeTestServices: true })("TerminalManager delivery", (it) => {
  it.effect("pauses the PTY while any holder holds it and re-applies after restart", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const hold = (holderId: string, held: boolean) =>
        manager.setOutputHold!({ threadId: "thread-1", terminalId: "default", holderId, held });

      expect(yield* hold("a", true)).toBe(true);
      yield* hold("b", true);
      expect(ptyAdapter.processes[0]?.paused).toBe(true);
      yield* hold("a", false);
      expect(ptyAdapter.processes[0]?.paused).toBe(true);
      yield* hold("b", false);
      expect(ptyAdapter.processes[0]?.paused).toBe(false);

      yield* hold("a", true);
      yield* manager.restart(restartInput());
      expect(ptyAdapter.processes[1]?.paused).toBe(false);
      // A holder that sees the restart re-asserts its hold on the new process.
      yield* hold("a", true);
      expect(ptyAdapter.processes[1]?.paused).toBe(true);
    }),
  );

  it.effect("limits the global stream's output to client-side detection sessions", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      const scoped: TerminalEvent[] = [];
      const unsubscribe = yield* manager.subscribe(
        (event) => Effect.sync(() => void scoped.push(event)),
        { outputScope: "legacyDetection" },
      );
      yield* manager.open(openInput({ terminalId: "local" }));
      yield* manager.open(
        openInput({ terminalId: "remote", executionTargetId: REMOTE_TARGET, cwd: "/root" }),
      );
      ptyAdapter.processes[0]?.emitData("local-output");
      ptyAdapter.processes[1]?.emitData("remote-output");
      yield* waitFor(
        Effect.sync(() => scoped.some((event) => event.type === "output")),
        "1200 millis",
      );
      yield* Effect.sleep("50 millis");
      const outputs = scoped.filter((event) => event.type === "output");
      expect(outputs.map((event) => event.terminalId)).toEqual(["remote"]);
      expect(scoped.some((event) => event.type === "started" && event.terminalId === "local")).toBe(
        true,
      );
      unsubscribe();
    }),
  );
});
