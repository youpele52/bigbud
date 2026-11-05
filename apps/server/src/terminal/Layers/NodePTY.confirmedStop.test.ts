import { tmpdir } from "node:os";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it, vi } from "vitest";
import { PtyAdapter } from "../Services/PTY";
import * as NodePTY from "./NodePTY";
import { confirmTerminalProcessStopped } from "./Manager.process.stop";
import { createTerminalSessionState } from "./Manager.session.state";

const loadAdapter = () =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* PtyAdapter;
    }).pipe(Effect.provide(NodePTY.layer.pipe(Layer.provide(NodeServices.layer)))),
  );

describe.skipIf(process.platform === "win32")("native confirmed PTY stop", () => {
  it.each([false, true])("confirms actual native exit (ignore TERM=%s)", async (ignoreTerm) => {
    const pty = await loadAdapter();
    const handle = await Effect.runPromise(
      pty.spawn({
        shell: "/bin/sh",
        args: [
          "-c",
          `${ignoreTerm ? "trap '' TERM; " : ""}printf READY; while :; do read value; done`,
        ],
        cwd: tmpdir(),
        cols: 80,
        rows: 24,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      }),
    );
    let stopped = false;
    let output = "";
    let ready!: () => void;
    const readiness = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const unsubscribeData = handle.onData((data) => {
      output += data;
      if (output.includes("READY")) ready();
    });
    const unsubscribeExit = handle.onExit(() => {
      stopped = true;
    });
    const kill = vi.spyOn(handle, "kill");
    const session = createTerminalSessionState({
      threadId: "native-stop",
      terminalId: "shell",
      executionTargetId: "local",
      dropPathMode: "posix",
      cwd: tmpdir(),
      worktreePath: null,
      history: "",
      cols: 80,
      rows: 24,
      runtimeEnv: null,
    });
    session.process = handle;
    session.pid = handle.pid;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        readiness,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Native shell did not become ready")), 5_000);
        }),
      ]);
      await Effect.runPromise(confirmTerminalProcessStopped(session, 100));
      expect(stopped).toBe(true);
      expect(() => process.kill(handle.pid, 0)).toThrow();
      expect(kill.mock.calls.map(([signal]) => signal)).toEqual(
        ignoreTerm ? ["SIGTERM", "SIGKILL"] : ["SIGTERM"],
      );
    } finally {
      clearTimeout(timer);
      unsubscribeData();
      unsubscribeExit();
      kill.mockRestore();
      if (!stopped) handle.kill("SIGKILL");
    }
  });
});
