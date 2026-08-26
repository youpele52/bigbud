import { ThreadId, type ProviderSession } from "@bigbud/contracts";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";

import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import type { ProviderSessionDirectoryShape } from "../Services/ProviderSessionDirectory.ts";
import { makeListSessionsForReconciliation } from "./ProviderService.operations.ts";
import { ProviderAdapterSessionNotFoundError } from "../Errors.ts";

const session: ProviderSession = {
  provider: "codex",
  status: "running",
  runtimeMode: "full-access",
  threadId: ThreadId.makeUnsafe("healthy-provider-thread"),
  createdAt: "2026-08-13T00:00:00.000Z",
  updatedAt: "2026-08-13T00:00:00.000Z",
};

const directory = {
  listThreadIds: () => Effect.succeed([]),
  listBindings: () => Effect.succeed([]),
  getBinding: () => Effect.succeed(Option.none()),
} as unknown as ProviderSessionDirectoryShape;

describe("provider reconciliation discovery", () => {
  it("keeps healthy provider sessions when another provider listing fails", async () => {
    const healthy = {
      provider: "codex",
      listSessions: () => Effect.succeed([session]),
    } as unknown as ProviderAdapterShape<never>;
    const broken = {
      provider: "claudeAgent",
      listSessions: () =>
        Effect.fail(
          new ProviderAdapterSessionNotFoundError({
            provider: "claudeAgent",
            threadId: ThreadId.makeUnsafe("failed-listing"),
          }),
        ),
    } as unknown as ProviderAdapterShape<ProviderAdapterSessionNotFoundError>;

    const result = await Effect.runPromise(
      makeListSessionsForReconciliation([healthy, broken], directory)(),
    );

    expect(result.sessions).toEqual([session]);
    expect(result.availableProviders.has("codex")).toBe(true);
    expect(result.unavailableProviders.has("claudeAgent")).toBe(true);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ provider: "claudeAgent", source: "adapter", kind: "error" }),
    ]);
  });

  it("reads persisted bindings through one bulk directory operation", async () => {
    let listThreadIdsCalls = 0;
    let getBindingCalls = 0;
    const bulkDirectory = {
      listThreadIds: () => {
        listThreadIdsCalls += 1;
        return Effect.succeed([ThreadId.makeUnsafe("historical-thread")]);
      },
      getBinding: () => {
        getBindingCalls += 1;
        return Effect.succeed(Option.none());
      },
      listBindings: () =>
        Effect.succeed([
          {
            threadId: ThreadId.makeUnsafe("historical-thread"),
            provider: "codex" as const,
            runtimeMode: "full-access" as const,
          },
        ]),
    } as unknown as ProviderSessionDirectoryShape;

    const result = await Effect.runPromise(
      makeListSessionsForReconciliation([healthyAdapter()], bulkDirectory)(),
    );

    expect(result.directoryAvailable).toBe(true);
    expect(listThreadIdsCalls).toBe(0);
    expect(getBindingCalls).toBe(0);
  });
});

function healthyAdapter(): ProviderAdapterShape<never> {
  return {
    provider: "codex",
    listSessions: () => Effect.succeed([session]),
  } as unknown as ProviderAdapterShape<never>;
}
