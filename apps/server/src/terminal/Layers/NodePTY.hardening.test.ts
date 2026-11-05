import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Exit, Layer } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PtyAdapter } from "../Services/PTY";
import { isRetryableShellSpawnError } from "./Manager.shell";
import * as NodePTY from "./NodePTY";
import { ensureLocalShellExecutable, isLocalShellExecutable } from "./PtyShellExecutable";

const POSIX = process.platform !== "win32";
const stalled = () => new Promise<boolean>(() => undefined);

describe("isBenignNodePtyReadError", () => {
  it("matches only the codes node-pty ignores itself", () => {
    expect(NodePTY.isBenignNodePtyReadError({ code: "EAGAIN" })).toBe(true);
    expect(NodePTY.isBenignNodePtyReadError({ code: "EIO" })).toBe(true);
    expect(NodePTY.isBenignNodePtyReadError({ code: "errno 5" })).toBe(true);
    expect(NodePTY.isBenignNodePtyReadError({ code: "EBADF" })).toBe(false);
    expect(NodePTY.isBenignNodePtyReadError(new Error("no code"))).toBe(false);
    expect(NodePTY.isBenignNodePtyReadError(null)).toBe(false);
  });

  it("treats EAGAIN as fatal on Windows, where node-pty closes the terminal for it", () => {
    expect(NodePTY.isBenignNodePtyReadError({ code: "EAGAIN" }, "win32")).toBe(false);
    expect(NodePTY.isBenignNodePtyReadError({ code: "EIO" }, "win32")).toBe(true);
  });
});

describe("NodePtyProcess read errors", () => {
  const makeFakePty = () => {
    const socket = new EventEmitter();
    // node-pty's own first listener: rethrows unless a second `error` listener exists.
    socket.on("error", (error: { code?: string }) => {
      if (error.code === "EAGAIN" || error.code === "EIO") return;
      if (socket.listenerCount("error") < 2) throw error;
    });
    const kills: Array<string | undefined> = [];
    const pty = {
      pid: 4242,
      on: (event: string, listener: (...args: unknown[]) => void) => socket.on(event, listener),
      onExit: (listener: () => void) => {
        socket.on("exit", listener);
        return { dispose: () => socket.off("exit", listener) };
      },
      kill: (signal?: string) => kills.push(signal),
    };
    return { socket, kills, pty: pty as unknown as import("node-pty").IPty };
  };

  it("registers a listener so node-pty never rethrows, and ends the process", () => {
    const { socket, kills, pty } = makeFakePty();
    const reported: Array<{ error: unknown; pid: number }> = [];
    const wrapped = new NodePTY.NodePtyProcess(pty, (error, pid) => reported.push({ error, pid }));
    expect(wrapped.pid).toBe(4242);

    const error = Object.assign(new Error("read EBADF"), { code: "EBADF" });
    expect(() => socket.emit("error", error)).not.toThrow();
    expect(socket.listenerCount("error")).toBe(2);
    expect(reported).toEqual([{ error, pid: 4242 }]);
    expect(kills).toEqual(["SIGHUP"]);
    socket.emit("exit");
  });

  it("ignores startup and exit read errors", () => {
    const { socket, kills, pty } = makeFakePty();
    const reported: unknown[] = [];
    const wrapped = new NodePTY.NodePtyProcess(pty, (error) => reported.push(error));
    expect(wrapped.pid).toBe(4242);

    socket.emit("error", Object.assign(new Error("EAGAIN"), { code: "EAGAIN" }));
    socket.emit("error", Object.assign(new Error("read EIO"), { code: "EIO" }));

    expect(reported).toEqual([]);
    expect(kills).toEqual([]);
  });
});

describe.skipIf(!POSIX)("isLocalShellExecutable", () => {
  let dir = "";
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "bigbud-shell-check-"));
    await writeFile(path.join(dir, "good-shell"), "#!/bin/sh\nexit 0\n");
    await chmod(path.join(dir, "good-shell"), 0o755);
    await writeFile(path.join(dir, "plain-file"), "not a shell\n");
    await chmod(path.join(dir, "plain-file"), 0o644);
    await mkdir(path.join(dir, "a-directory"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const check = (shell: string) => isLocalShellExecutable({ shell, cwd: dir });

  it("accepts executable absolute and relative shells", async () => {
    expect(await check(path.join(dir, "good-shell"))).toBe(true);
    expect(await check("./good-shell")).toBe(true);
  });

  it("leaves bare names to the spawn's own PATH lookup", async () => {
    expect(await check("sh")).toBe(true);
    expect(await check("bigbud-no-such-shell-name")).toBe(true);
  });

  it("rejects missing, non-executable and directory shells", async () => {
    expect(await check("/definitely/missing-shell")).toBe(false);
    expect(await check(path.join(dir, "plain-file"))).toBe(false);
    expect(await check(path.join(dir, "a-directory"))).toBe(false);
    expect(await check("")).toBe(false);
  });
});

describe("ensureLocalShellExecutable", () => {
  it.skipIf(!POSIX)("lets the spawn proceed when the check does not answer in time", async () => {
    const exit = await Effect.runPromiseExit(
      ensureLocalShellExecutable(
        "node-pty",
        { shell: "/stalled/mount/zsh", cwd: "/" },
        20,
        stalled,
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it.skipIf(!POSIX)("still rejects a shell the check answers as missing", async () => {
    const exit = await Effect.runPromiseExit(
      ensureLocalShellExecutable("node-pty", { shell: "/definitely/missing-shell", cwd: "/" }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });
});

describe.skipIf(!POSIX)("NodePTY spawn of a missing shell", () => {
  it("fails with a retryable spawn error instead of a process that exits immediately", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const adapter = yield* PtyAdapter;
        return yield* adapter.spawn({
          shell: "/definitely/missing-shell",
          cwd: tmpdir(),
          cols: 80,
          rows: 24,
          env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
        });
      }).pipe(Effect.provide(NodePTY.layer.pipe(Layer.provide(NodeServices.layer)))),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = exit.cause.reasons.find((reason) => reason._tag === "Fail");
      const failure = error?._tag === "Fail" ? error.error : null;
      expect(failure?._tag).toBe("PtySpawnError");
      expect(failure && isRetryableShellSpawnError(failure)).toBe(true);
    }
  });
});

describe("makeUnavailableNodePtyAdapter", () => {
  it("fails spawns with a clear message instead of stopping the server", async () => {
    const adapter = NodePTY.makeUnavailableNodePtyAdapter(new Error("dlopen failed"));
    const exit = await Effect.runPromiseExit(
      adapter.spawn({ shell: "/bin/sh", cwd: tmpdir(), cols: 80, rows: 24, env: {} }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const reason = exit.cause.reasons.find((entry) => entry._tag === "Fail");
      const failure = reason?._tag === "Fail" ? reason.error : null;
      expect(failure?.message).toContain("Terminal support is unavailable");
    }
  });
});
