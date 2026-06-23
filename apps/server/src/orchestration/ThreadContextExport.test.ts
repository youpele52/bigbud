import * as fs from "node:fs/promises";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@bigbud/contracts";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { ServerConfig } from "../startup/config.ts";
import { exportThreadContext, resolveThreadContextPath } from "./ThreadContextExport.ts";

async function getTestConfig() {
  const layer = Layer.empty.pipe(
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-thread-context-export-test-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
  return Effect.runPromise(
    Effect.gen(function* () {
      return yield* ServerConfig;
    }).pipe(Effect.provide(layer)),
  );
}

describe("ThreadContextExport", () => {
  it("exports a thread to a deterministic markdown file", async () => {
    const config = await getTestConfig();
    const threadId = ThreadId.makeUnsafe("thread-export-test");
    const snapshot = {
      threads: [
        {
          id: threadId,
          title: "Test Thread",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-02T00:00:00.000Z",
          messages: [
            {
              role: "user" as const,
              text: "Hello",
              createdAt: "2026-01-01T00:00:00.000Z",
            },
            {
              role: "assistant" as const,
              text: "Hi there",
              createdAt: "2026-01-01T00:00:01.000Z",
            },
          ],
        },
      ],
    };

    const { path: filePath } = await exportThreadContext({
      threadId,
      snapshot: snapshot as any,
      stateDir: config.stateDir,
    });

    expect(filePath).toBe(resolveThreadContextPath({ threadId, stateDir: config.stateDir }));
    const content = await fs.readFile(filePath, "utf8");
    expect(content).toContain("# Test Thread");
    expect(content).toContain("Thread ID: thread-export-test");
    expect(content).toContain("## User");
    expect(content).toContain("Hello");
    expect(content).toContain("## Assistant");
    expect(content).toContain("Hi there");
  });

  it("throws when the thread is not found in the snapshot", async () => {
    const config = await getTestConfig();
    const threadId = ThreadId.makeUnsafe("thread-missing");
    await expect(
      exportThreadContext({
        threadId,
        snapshot: { threads: [] } as any,
        stateDir: config.stateDir,
      }),
    ).rejects.toThrow("Thread 'thread-missing' not found");
  });
});
