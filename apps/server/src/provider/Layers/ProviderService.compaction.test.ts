import { describe, expect, it, vi } from "vitest";
import { Effect, Option } from "effect";
import { ThreadId, EventId } from "@bigbud/contracts/core/baseSchemas.ts";
import type { ProviderRuntimeEvent } from "@bigbud/contracts/orchestration/providerRuntime.events.ts";
import type { ProviderSessionDirectoryShape } from "../Services/ProviderSessionDirectory.ts";
import type { ProviderAdapterRegistryShape } from "../Services/ProviderAdapterRegistry.ts";
import { CODEX_COMPACTION_COMPLETED } from "../Services/ProviderCompaction.ts";
import { makeCompactionDelivery } from "./ProviderService.compaction.ts";
import { makeThreadOperations } from "./ProviderService.threadOperations.ts";
import { codexReliabilityHarness } from "../../codex/codexAppServerManager.reliability.test.helpers.ts";
import {
  compactBlocksWork,
  confirmCodexCompaction,
} from "../../codex/codexAppServerManager.controls.state.ts";

const event: ProviderRuntimeEvent = {
  eventId: EventId.makeUnsafe("proof"),
  threadId: ThreadId.makeUnsafe("thread"),
  provider: "codex",
  sessionEpoch: 2,
  type: "thread.state.changed",
  payload: { state: "compacted" },
  createdAt: "2026-10-30T00:00:00.000Z",
  raw: {
    source: "codex.app-server.notification",
    method: CODEX_COMPACTION_COMPLETED,
    payload: { nativeThreadId: "native", turnId: "manual", itemId: "compact" },
  },
};

describe("durable manual compaction acknowledgment", () => {
  it("keeps the real native completion fenced when its proof write fails", async () => {
    const { context } = codexReliabilityHarness();
    context.manualCompact = {
      state: "working",
      deadline: Date.now() + 60_000,
      dispatched: true,
      itemCompleted: true,
      terminalStatus: "completed",
      turnId: "manual",
      itemId: "compact",
    };
    const directory = {
      getBinding: () => Effect.succeed(Option.none()),
      recordCodexCompaction: () => Effect.fail(new Error("storage failure")),
    } as unknown as ProviderSessionDirectoryShape;
    const registry = {
      getByProvider: () =>
        Effect.succeed({
          confirmCompaction: (
            input: Parameters<typeof confirmCodexCompaction>[1],
            persisted: boolean,
          ) => Effect.sync(() => confirmCodexCompaction(context, input, persisted)),
        }),
    } as unknown as ProviderAdapterRegistryShape;
    const publish = vi.fn(() => Effect.void);
    await Effect.runPromise(
      makeCompactionDelivery(
        registry,
        directory,
        makeThreadOperations(directory),
        publish,
      )({ ...event, threadId: context.session.threadId }),
    );
    expect(context.manualCompact.state).toBe("working");
    expect(context.manualCompact.proofRecorded).toBeUndefined();
    expect(compactBlocksWork(context)).toBe(true);
    expect(publish).not.toHaveBeenCalled();
    context.manualCompact.deadline = Date.now() - 1;
    expect(compactBlocksWork(context)).toBe(true);
    expect(context.manualCompact.state).toBe("unknown");
  });
  it.each(["unavailable", "storage", "stale-process", "invalid-proof"])(
    "does not expose completion after %s failure",
    async (failure) => {
      const record = vi.fn(() =>
        failure === "storage" ? Effect.fail(new Error("write failed")) : Effect.void,
      );
      const confirm = vi.fn(() => Effect.succeed(failure !== "stale-process"));
      const publish = vi.fn(() => Effect.void);
      const directory = {
        getBinding: () => Effect.succeed(Option.none()),
        ...(failure !== "unavailable" ? { recordCodexCompaction: record } : {}),
      } as unknown as ProviderSessionDirectoryShape;
      const registry = {
        getByProvider: () => Effect.succeed({ confirmCompaction: confirm }),
      } as unknown as ProviderAdapterRegistryShape;
      const deliver = makeCompactionDelivery(
        registry,
        directory,
        makeThreadOperations(directory),
        publish,
      );
      await Effect.runPromise(
        deliver(
          failure === "invalid-proof"
            ? ({ ...event, sessionEpoch: undefined } as unknown as ProviderRuntimeEvent)
            : event,
        ),
      );
      expect(publish).not.toHaveBeenCalled();
      if (failure === "unavailable" || failure === "invalid-proof")
        expect(confirm).not.toHaveBeenCalled();
      else expect(confirm).toHaveBeenCalledTimes(1);
      if (failure === "stale-process") expect(record).not.toHaveBeenCalled();
    },
  );
});
