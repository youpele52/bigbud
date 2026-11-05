import { createRequire } from "node:module";

import { Effect, FileSystem, Layer, Path } from "effect";
import {
  PtyAdapter,
  PtyAdapterShape,
  PtyExitEvent,
  PtyProcess,
  PtySpawnError,
} from "../Services/PTY";
import { terminalNodePtyArgs } from "./NodePTY.wsl";
import { NodePtyReadFailure } from "./NodePTY.readFailure";
import { ensureLocalShellExecutable, ptySpawnErrorFromThrown } from "./PtyShellExecutable";

let didEnsureSpawnHelperExecutable = false;

const resolveNodePtySpawnHelperPath = Effect.gen(function* () {
  const requireForNodePty = createRequire(import.meta.url);
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;

  const packageJsonPath = requireForNodePty.resolve("node-pty/package.json");
  const packageDir = path.dirname(packageJsonPath);
  const candidates = [
    path.join(packageDir, "build", "Release", "spawn-helper"),
    path.join(packageDir, "build", "Debug", "spawn-helper"),
    path.join(packageDir, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
  ];

  for (const candidate of candidates) {
    if (yield* fs.exists(candidate)) {
      return candidate;
    }
  }
  return null;
}).pipe(Effect.orElseSucceed(() => null));

// node-pty 1.1.0 (the stable release bigbud uses) ships prebuilt `spawn-helper` as 0644, and
// copied or from-source installs (`build/Release`) can also lose the bit, so repair it.
export const ensureNodePtySpawnHelperExecutable = Effect.fn(function* (explicitPath?: string) {
  const fs = yield* FileSystem.FileSystem;
  if (process.platform === "win32") return;
  if (!explicitPath && didEnsureSpawnHelperExecutable) return;

  const helperPath = explicitPath ?? (yield* resolveNodePtySpawnHelperPath);
  if (!helperPath) return;
  if (!explicitPath) {
    didEnsureSpawnHelperExecutable = true;
  }

  if (!(yield* fs.exists(helperPath))) {
    return;
  }

  // Best-effort: avoid FileSystem.stat in packaged mode where some fs metadata can be missing.
  yield* fs.chmod(helperPath, 0o755).pipe(Effect.orElseSucceed(() => undefined));
});

/**
 * node-pty ignores these read-stream errors itself: EAGAIN while the stream starts and EIO when
 * the child exits. Every other error closes the terminal and is rethrown from the socket's
 * listener unless a second `error` listener exists, which would end the backend process.
 */
export function isBenignNodePtyReadError(
  error: unknown,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code !== "string") return false;
  // Windows node-pty closes the terminal on EAGAIN, so only Unix treats it as benign.
  if (platform !== "win32" && code.includes("EAGAIN")) return true;
  return code.includes("EIO") || code.includes("errno 5");
}

/** node-pty forwards `on` to its read socket; the public typings omit it. */
interface NodePtyEventSource {
  on(event: "error", listener: (error: unknown) => void): void;
}

export type NodePtyReadErrorHandler = (error: unknown, pid: number) => void;

export class NodePtyProcess implements PtyProcess {
  private readonly readFailure: NodePtyReadFailure;

  constructor(
    private readonly process: import("node-pty").IPty,
    onReadError: NodePtyReadErrorHandler = () => undefined,
  ) {
    this.readFailure = new NodePtyReadFailure(process);
    (process as unknown as NodePtyEventSource).on("error", (error) => {
      if (isBenignNodePtyReadError(error)) return;
      this.readFailure.fail(error, () => onReadError(error, process.pid));
    });
  }

  get pid(): number {
    return this.process.pid;
  }

  write(data: string): void {
    this.readFailure.assertUsable();
    this.process.write(data);
  }

  pause = (): void => {
    if (!this.readFailure.failed) this.process.pause();
  };

  resume = (): void => {
    // Shutdown may still need to resume reads after an I/O failure.
    this.process.resume();
  };

  resize(cols: number, rows: number): void {
    this.readFailure.assertUsable();
    this.process.resize(cols, rows);
  }

  kill(signal?: string): void {
    this.process.kill(signal);
  }

  onError(callback: (error: Error) => void): () => void {
    return this.readFailure.onError(callback);
  }

  onData(callback: (data: string) => void): () => void {
    const disposable = this.process.onData((data) => {
      if (!this.readFailure.failed) callback(data);
    });
    return () => {
      disposable.dispose();
    };
  }

  onExit(callback: (event: PtyExitEvent) => void): () => void {
    const disposable = this.process.onExit((event) => {
      callback({
        exitCode: event.exitCode,
        signal: event.signal ?? null,
      });
    });
    return () => {
      disposable.dispose();
    };
  }
}

export const layer = Layer.effect(
  PtyAdapter,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const runFork = Effect.runForkWith(yield* Effect.services());
    const loaded = yield* Effect.tryPromise({
      try: () => import("node-pty"),
      catch: (cause) => ptySpawnErrorFromThrown("node-pty", cause),
    }).pipe(Effect.result);
    if (loaded._tag === "Failure") {
      yield* Effect.logError("terminal support unavailable: node-pty failed to load", {
        error: loaded.failure.message,
      });
      return makeUnavailableNodePtyAdapter(loaded.failure.cause);
    }
    const nodePty = loaded.success;
    const onReadError: NodePtyReadErrorHandler = (error, pid) =>
      runFork(
        Effect.logWarning("terminal pty read failed; ending the terminal process", {
          pid,
          code: (error as { code?: unknown } | null)?.code ?? null,
          error: error instanceof Error ? error.message : String(error),
        }),
      );

    const ensureNodePtySpawnHelperExecutableCached = yield* Effect.cached(
      ensureNodePtySpawnHelperExecutable().pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.orElseSucceed(() => undefined),
      ),
    );

    return {
      spawn: Effect.fn(function* (input) {
        yield* ensureNodePtySpawnHelperExecutableCached;
        yield* ensureLocalShellExecutable("node-pty", input);
        const ptyProcess = yield* Effect.try({
          try: () =>
            nodePty.spawn(
              input.shell,
              terminalNodePtyArgs(input.args ?? [], input.executionTargetId),
              {
                cwd: input.cwd,
                cols: input.cols,
                rows: input.rows,
                env: input.env,
                name: globalThis.process.platform === "win32" ? "xterm-color" : "xterm-256color",
              },
            ),
          catch: (cause) => ptySpawnErrorFromThrown("node-pty", cause),
        });
        return new NodePtyProcess(ptyProcess, onReadError);
      }),
    } satisfies PtyAdapterShape;
  }),
);

/** Keeps the backend running when the native module cannot load; only local terminals fail. */
export function makeUnavailableNodePtyAdapter(cause: unknown): PtyAdapterShape {
  return {
    spawn: () =>
      Effect.fail(
        new PtySpawnError({
          adapter: "node-pty",
          message: "Terminal support is unavailable: node-pty failed to load.",
          cause,
        }),
      ),
  };
}
