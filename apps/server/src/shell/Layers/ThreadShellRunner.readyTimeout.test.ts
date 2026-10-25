import { describe, expect, it } from "vitest";

import type { PtyExitEvent, PtyProcess } from "../../terminal/Services/PTY";
import { PersistentThreadPtyShellRunner } from "./ThreadShellRunner";

/** A PTY whose shell never prints anything, so the ready marker never arrives. */
class SilentPtyProcess implements PtyProcess {
  readonly kills: Array<string | undefined> = [];
  private readonly exitListeners = new Set<(event: PtyExitEvent) => void>();

  constructor(readonly pid: number) {}

  write(): void {}

  resize(): void {}

  kill(signal?: string): void {
    this.kills.push(signal);
    for (const listener of this.exitListeners) {
      listener({ exitCode: 137, signal: 9 });
    }
  }

  onData(): () => void {
    return () => undefined;
  }

  onExit(callback: (event: PtyExitEvent) => void): () => void {
    this.exitListeners.add(callback);
    return () => {
      this.exitListeners.delete(callback);
    };
  }
}

type Settled =
  | { readonly status: "resolved" }
  | { readonly status: "rejected"; readonly error: Error };

/** Settles `promise`, or reports "pending" if it has not settled within `ms`. */
async function settleWithin(promise: Promise<unknown>, ms: number): Promise<Settled | "pending"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = new Promise<"pending">((resolve) => {
    timer = setTimeout(() => resolve("pending"), ms);
  });
  const settled = promise.then(
    (): Settled => ({ status: "resolved" }),
    (error: unknown): Settled => ({
      status: "rejected",
      error: error instanceof Error ? error : new Error(String(error)),
    }),
  );
  try {
    return await Promise.race([settled, pending]);
  } finally {
    clearTimeout(timer);
  }
}

describe("PersistentThreadPtyShellRunner ready timeout", () => {
  it("fails, kills the PTY and releases the thread when the shell never becomes ready", async () => {
    const spawned: SilentPtyProcess[] = [];
    const released: string[] = [];
    const runner = new PersistentThreadPtyShellRunner({
      spawnPty: async () => {
        const process = new SilentPtyProcess(1000 + spawned.length);
        spawned.push(process);
        return process;
      },
      shellResolver: () => "/bin/zsh",
      baseEnv: {},
      commandTimeoutMs: 100,
      releaseLease: async (threadId) => {
        released.push(threadId);
      },
    });

    const first = await settleWithin(
      runner.run({ threadId: "thread-hung-init", cwd: "/", command: "true" }),
      2_000,
    );

    expect(first).not.toBe("pending");
    expect(first).toMatchObject({ status: "rejected" });
    expect(first !== "pending" && first.status === "rejected" ? first.error.message : "").toMatch(
      /did not become ready within 100ms/,
    );
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.kills).toEqual(["SIGKILL"]);
    expect(released).toContain("thread-hung-init");
    expect(runner.isActive("thread-hung-init")).toBe(false);

    // The timed-out session is never reused: the next run spawns a fresh shell.
    const second = await settleWithin(
      runner.run({ threadId: "thread-hung-init", cwd: "/", command: "true" }),
      2_000,
    );
    expect(second).toMatchObject({ status: "rejected" });
    expect(spawned).toHaveLength(2);
    expect(spawned[1]?.kills).toEqual(["SIGKILL"]);

    await runner.closeAll();
  });
});
