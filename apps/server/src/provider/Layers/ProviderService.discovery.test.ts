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
});
