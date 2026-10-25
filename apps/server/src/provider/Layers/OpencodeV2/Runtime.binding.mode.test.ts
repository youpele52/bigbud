import { Effect } from "effect";
import { expect, it } from "vitest";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { OpencodeV2Runtime } from "./Runtime.ts";
import { sharedV2FixtureOptions } from "./SharedService.binding.fixture.ts";
import { realpath } from "node:fs/promises";

it("retired isolated and unknown retained cursors stay read-only before acquisition, without writing replacement binding evidence", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory }) => {
    const shared = new OpencodeV2Runtime(sharedV2FixtureOptions(runtime, http));
    try {
      for (const connectionMode of ["isolated", undefined]) {
        const threadId = ThreadId.makeUnsafe(`retained-${connectionMode ?? "unknown"}`);
        const cursor = {
          provider: "opencodeV2",
          nativeSessionId: "original-native",
          storageIdentity: "original-private-storage",
          directory: await realpath(directory),
          ...(connectionMode ? { connectionMode } : {}),
        };
        const original = JSON.stringify(cursor);
        await expect(
          shared.start({
            threadId,
            cwd: directory,
            runtimeMode: "approval-required",
            modelSelection: {
              provider: "opencodeV2",
              subProviderID: "synthetic-provider",
              model: "synthetic-model",
            },
            resumeCursor: cursor,
          }),
        ).rejects.toThrow(/read-only|unsupported-retained-binding/);
        expect(JSON.stringify(cursor)).toBe(original);
        expect(
          await Effect.runPromise(runtime.options.sharedBindings!.find(threadId)),
        ).toBeUndefined();
        expect(
          await Effect.runPromise(runtime.options.journal.latestBound(threadId)),
        ).toBeUndefined();
      }
      expect(http.calls).toHaveLength(0);
    } finally {
      await shared.close();
    }
  });
});

it("retained shared lost-create evidence blocks isolated acquisition without cursor or journal before any native request", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory }) => {
    const shared = new OpencodeV2Runtime(sharedV2FixtureOptions(runtime, http));
    const input = {
      threadId: ThreadId.makeUnsafe("shared-intent-isolated"),
      cwd: directory,
      runtimeMode: "approval-required" as const,
      modelSelection: {
        provider: "opencodeV2" as const,
        subProviderID: "synthetic-provider",
        model: "synthetic-model",
      },
    };
    try {
      http.loseCreateAck = true;
      await expect(shared.start(input)).rejects.toThrow();
      const retained = JSON.stringify(
        await Effect.runPromise(runtime.options.sharedBindings!.find(input.threadId)),
      );
      expect(
        await Effect.runPromise(runtime.options.journal.latestBound(input.threadId)),
      ).toBeUndefined();
      http.loseCreateAck = false;
      const requests = http.calls.length;
      await expect(runtime.start(input)).rejects.toThrow("retained shared history");
      expect(http.calls).toHaveLength(requests);
      expect(
        JSON.stringify(
          await Effect.runPromise(runtime.options.sharedBindings!.find(input.threadId)),
        ),
      ).toBe(retained);
      await runtime.start({ ...input, threadId: ThreadId.makeUnsafe("fresh-isolated") });
      expect(
        http.calls.filter((call) => call.method === "POST" && call.pathname === "/api/session"),
      ).toHaveLength(2);
      expect(http.calls.some((call) => call.pathname.endsWith("/prompt"))).toBe(false);
    } finally {
      await shared.close().catch(() => {});
    }
  });
});
