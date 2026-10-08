import fs from "node:fs/promises";
import path from "node:path";

import { CommandId, DEFAULT_PROVIDER_INTERACTION_MODE, ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import {
  asMessageId,
  createHarness,
  registerProviderCommandReactorTestCleanup,
} from "./ProviderCommandReactor.test.helpers.ts";

const pendingWrite = vi.hoisted(() => {
  let started!: () => void;
  let release!: () => void;
  return {
    started: new Promise<void>((resolve) => {
      started = resolve;
    }),
    gate: new Promise<void>((resolve) => {
      release = resolve;
    }),
    signalStarted: () => started(),
    release: () => release(),
  };
});

vi.mock("./ProviderCapabilityContextPersistence.ts", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("./ProviderCapabilityContextPersistence.ts")>();
  return {
    ...original,
    saveProviderCapabilityContextState: (input: { stateDir: string }) =>
      Effect.promise(async () => {
        pendingWrite.signalStarted();
        // Like native mkdir, this promise keeps writing after fiber interruption.
        await pendingWrite.gate;
        await fs.mkdir(path.join(input.stateDir, "capability-context"), { recursive: true });
      }),
  };
});

describe("ProviderCommandReactor harness cleanup", () => {
  registerProviderCommandReactorTestCleanup();

  it("settles pending native filesystem work before disposing the runtime", async () => {
    const harness = await createHarness();
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-cleanup-pending-write"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("message-cleanup-pending-write"),
          role: "user",
          text: "hello reactor",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: new Date().toISOString(),
      }),
    );
    await pendingWrite.started;

    let disposed = false;
    const cleanup = harness.cleanup().then(() => {
      disposed = true;
    });
    try {
      // A macrotask lets scope finalization run; no filesystem timing assumption.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(disposed).toBe(false);
    } finally {
      pendingWrite.release();
      await cleanup;
    }

    expect(disposed).toBe(true);
    expect(await fs.readdir(harness.stateDir)).toContain("capability-context");
  });
});
