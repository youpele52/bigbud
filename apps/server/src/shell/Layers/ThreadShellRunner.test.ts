import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import * as NodePTY from "../../terminal/Layers/NodePTY";
import {
  PtyAdapter,
  type PtyExitEvent,
  type PtyProcess,
  type PtySpawnInput,
} from "../../terminal/Services/PTY";
import { PersistentThreadPtyShellRunner } from "./ThreadShellRunner";

class BunTestPtyProcess implements PtyProcess {
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: PtyExitEvent) => void>();
  private readonly decoder = new TextDecoder();
  private didExit = false;

  constructor(private readonly process: Bun.Subprocess) {
    void this.process.exited
      .then((exitCode) => {
        this.emitExit({
          exitCode: Number.isInteger(exitCode) ? exitCode : 0,
          signal: typeof this.process.signalCode === "number" ? this.process.signalCode : null,
        });
      })
      .catch(() => {
        this.emitExit({ exitCode: 1, signal: null });
      });
  }

  get pid(): number {
    return this.process.pid;
  }

  write(data: string): void {
    this.process.terminal?.write(data);
  }

  resize(cols: number, rows: number): void {
    this.process.terminal?.resize?.(cols, rows);
  }

  kill(signal?: string): void {
    if (signal) {
      this.process.kill(signal as NodeJS.Signals);
      return;
    }
    this.process.kill();
  }

  onData(callback: (data: string) => void): () => void {
    this.dataListeners.add(callback);
    return () => {
      this.dataListeners.delete(callback);
    };
  }

  onExit(callback: (event: PtyExitEvent) => void): () => void {
    this.exitListeners.add(callback);
    return () => {
      this.exitListeners.delete(callback);
    };
  }

  emitData(data: Uint8Array): void {
    if (this.didExit) return;
    const text = this.decoder.decode(data, { stream: true });
    if (text.length === 0) return;
    for (const listener of this.dataListeners) {
      listener(text);
    }
  }

  private emitExit(event: PtyExitEvent): void {
    if (this.didExit) return;
    this.didExit = true;

    const remainder = this.decoder.decode();
    if (remainder.length > 0) {
      for (const listener of this.dataListeners) {
        listener(remainder);
      }
    }

    for (const listener of this.exitListeners) {
      listener(event);
    }
  }
}

// Spawn through the production node-pty adapter, not raw node-pty: node-pty 1.1.0 shipped
// `spawn-helper` without the executable bit and only the adapter's
// `ensureNodePtySpawnHelperExecutable` step repaired it (raw spawns failed with
// "posix_spawnp failed" in a fresh install). The adapter is the code path production uses.
const nodePtyAdapter = Effect.runPromise(
  Effect.gen(function* () {
    return yield* PtyAdapter;
  }).pipe(Effect.provide(NodePTY.layer.pipe(Layer.provide(NodeServices.layer)))),
);

async function spawnTestPty(input: PtySpawnInput): Promise<PtyProcess> {
  if (typeof Bun !== "undefined" && process.platform !== "win32") {
    let processHandle: BunTestPtyProcess | null = null;
    const subprocess = Bun.spawn([input.shell, ...(input.args ?? [])], {
      cwd: input.cwd,
      env: input.env,
      terminal: {
        cols: input.cols,
        rows: input.rows,
        data: (_terminal, data) => {
          processHandle?.emitData(data);
        },
      },
    });
    processHandle = new BunTestPtyProcess(subprocess);
    return processHandle;
  }

  const adapter = await nodePtyAdapter;
  return Effect.runPromise(adapter.spawn(input));
}

const tempDirs = new Set<string>();

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

describe.skipIf(process.platform === "win32" || !existsSync("/bin/zsh"))(
  "PersistentThreadPtyShellRunner",
  () => {
    it("loads aliases from interactive zsh config inside the hidden PTY shell", async () => {
      const zdotdir = mkdtempSync(path.join(tmpdir(), "bigbud-shell-zdotdir-"));
      tempDirs.add(zdotdir);
      writeFileSync(path.join(zdotdir, ".zshrc"), "alias dps='printf alias-ok'\n");

      const runner = new PersistentThreadPtyShellRunner({
        spawnPty: spawnTestPty,
        shellResolver: () => "/bin/zsh",
        baseEnv: {
          ...process.env,
          ZDOTDIR: zdotdir,
        },
      });

      try {
        const result = await runner.run({
          threadId: "thread-alias",
          cwd: zdotdir,
          command: "dps",
        });

        expect(result.output).toContain("alias-ok");
      } finally {
        await runner.closeAll();
      }
    });

    it("persists shell state per thread across commands", async () => {
      const zdotdir = mkdtempSync(path.join(tmpdir(), "bigbud-shell-state-"));
      tempDirs.add(zdotdir);
      writeFileSync(path.join(zdotdir, ".zshrc"), "");
      const childDir = path.join(zdotdir, "child");
      mkdirSync(childDir);

      const runner = new PersistentThreadPtyShellRunner({
        spawnPty: spawnTestPty,
        shellResolver: () => "/bin/zsh",
        baseEnv: {
          ...process.env,
          ZDOTDIR: zdotdir,
        },
      });

      try {
        await runner.run({
          threadId: "thread-stateful",
          cwd: zdotdir,
          command: "cd child",
        });
        const result = await runner.run({
          threadId: "thread-stateful",
          cwd: zdotdir,
          command: "pwd",
        });

        expect(result.output).toContain(childDir);
      } finally {
        await runner.closeAll();
      }
    });

    it("emits output chunks while the command is still running", async () => {
      const zdotdir = mkdtempSync(path.join(tmpdir(), "bigbud-shell-stream-"));
      tempDirs.add(zdotdir);
      writeFileSync(path.join(zdotdir, ".zshrc"), "");

      const runner = new PersistentThreadPtyShellRunner({
        spawnPty: spawnTestPty,
        shellResolver: () => "/bin/zsh",
        baseEnv: {
          ...process.env,
          ZDOTDIR: zdotdir,
        },
      });

      const chunks: string[] = [];

      try {
        const resultPromise = runner.run({
          threadId: "thread-streaming",
          cwd: zdotdir,
          command: "printf 'alpha\\n'; sleep 0.4; printf 'beta\\n'",
          onOutputChunk: (chunk) => {
            chunks.push(chunk);
          },
        });
        // Mark handled now so an early assertion failure below cannot also surface as an
        // unhandled rejection; `await resultPromise` still observes any failure.
        void resultPromise.catch(() => undefined);

        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(chunks.join("")).toContain("alpha");

        const result = await resultPromise;
        expect(result.output).toContain("alpha");
        expect(result.output).toContain("beta");
        expect(chunks.join("")).toContain("beta");
      } finally {
        await runner.closeAll();
      }
    });
  },
);
