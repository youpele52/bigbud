import { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import type { ProviderSession } from "@bigbud/contracts/orchestration/provider.ts";
import { Effect } from "effect";
import { expect, it, vi } from "vitest";

import type {
  ProviderRuntimeBinding,
  ProviderSessionDirectoryShape,
} from "../Services/ProviderSessionDirectory.ts";
import { makeRunStopAll } from "./ProviderService.operations.ts";

it.each(["running", "stopped"] as const)(
  "shutdown retains a %s legacy binding while stopping active providers normally",
  async (status) => {
    const legacyId = ThreadId.makeUnsafe("legacy-shutdown");
    const activeId = ThreadId.makeUnsafe("active-shutdown");
    const legacy: ProviderRuntimeBinding = {
      threadId: legacyId,
      provider: "opencode",
      status,
      resumeCursor: { nativeId: "retain-native-id" },
      runtimePayload: { activeTurnId: "historical-turn", sessionEpoch: 9, history: "retain" },
    };
    const before = structuredClone(legacy);
    const upsert = vi.fn(() => Effect.void);
    const upsertSessionBinding = vi.fn(() => Effect.void);
    const stopAll = vi.fn(() => Effect.void);
    const activeSession = { threadId: activeId, provider: "codex" } as ProviderSession;
    // An injected compatibility adapter must not cause legacy writes either.
    const legacySession = { threadId: legacyId, provider: "opencode" } as ProviderSession;
    const adapters = [
      { listSessions: () => Effect.succeed([activeSession, legacySession]), stopAll },
    ] as unknown as Parameters<typeof makeRunStopAll>[0];
    const directory = {
      listThreadIds: () => Effect.succeed([legacyId, activeId]),
      getProvider: (threadId: ThreadId) =>
        Effect.succeed(threadId === legacyId ? "opencode" : "codex"),
      upsert,
    } as unknown as ProviderSessionDirectoryShape;
    const analytics = { record: () => Effect.void, flush: Effect.void } as unknown as Parameters<
      typeof makeRunStopAll
    >[3];

    await Effect.runPromise(makeRunStopAll(adapters, directory, upsertSessionBinding, analytics));

    expect(stopAll).toHaveBeenCalledOnce();
    expect(upsertSessionBinding).toHaveBeenCalledOnce();
    expect(upsertSessionBinding).toHaveBeenCalledWith(
      activeSession,
      activeId,
      expect.objectContaining({ lastRuntimeEvent: "provider.stopAll" }),
    );
    expect(upsert).toHaveBeenCalledOnce();
    expect(upsert.mock.calls[0]).toMatchObject([
      { threadId: activeId, provider: "codex", status: "stopped" },
    ]);
    expect(legacy).toEqual(before);
  },
);
