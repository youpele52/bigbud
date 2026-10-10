import { Effect, Option } from "effect";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SERVER_SETTINGS } from "@bigbud/contracts/core/settings.ts";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { LEGACY_OPENCODE_READ_ONLY_MESSAGE } from "@bigbud/shared/providerLifecycle";
import { prepareProviderSession } from "./ProviderService.prepareSession.ts";
import {
  makeRecoverSessionForThread,
  makeResolveRoutableSession,
} from "./ProviderServiceSessionRouting.ts";
import { getProviderCapabilities } from "../providerCapabilities.ts";
import type {
  ProviderSessionDirectoryShape,
  ProviderRuntimeBinding,
} from "../Services/ProviderSessionDirectory.ts";
import type { ProviderAdapterRegistryShape } from "../Services/ProviderAdapterRegistry.ts";
import type { AnalyticsServiceShape } from "../../telemetry/Services/AnalyticsService.ts";

const binding: ProviderRuntimeBinding = {
  threadId: ThreadId.makeUnsafe("legacy"),
  provider: "opencode",
  resumeCursor: { nativeId: "original" },
  runtimePayload: { modelSelection: { provider: "opencode", model: "original" } },
};
const lookup = vi.fn(() => Effect.die("legacy lookup must never occur"));
const registry: ProviderAdapterRegistryShape = {
  getByProvider: lookup,
  listProviders: () => Effect.succeed([]),
};
const write = vi.fn(() => Effect.void);
const directory: ProviderSessionDirectoryShape = {
  getBinding: () => Effect.succeed(Option.some(binding)),
  getProvider: () => Effect.succeed(binding.provider),
  upsert: write,
  remove: write,
  listBindings: () => Effect.succeed([binding]),
  listThreadIds: () => Effect.succeed([binding.threadId]),
};
const analytics = { record: write } as unknown as AnalyticsServiceShape;

describe("legacy runtime read-only boundaries", () => {
  it.each(["opencode", "opencodeV2", "codex"] as const)(
    "rejects %s starts against legacy bindings before configuration or mutation",
    async (provider) => {
      const result = await Effect.runPromise(
        Effect.result(
          prepareProviderSession(
            {
              serverSettings: { getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS) },
              getProviderCapabilities,
              isProviderComposed: () => true,
            },
            binding.threadId,
            { threadId: binding.threadId, provider, runtimeMode: "full-access" },
            binding,
          ),
        ),
      );
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { issue: LEGACY_OPENCODE_READ_ONLY_MESSAGE },
      });
      expect(write).not.toHaveBeenCalled();
    },
  );
  it("cold recovery and command routing never look up or start the legacy adapter", async () => {
    const recover = makeRecoverSessionForThread(
      registry,
      directory,
      write,
      analytics,
      getProviderCapabilities,
    );
    const route = makeResolveRoutableSession(registry, directory, recover, () => true);
    const before = structuredClone(binding);
    for (const operation of [
      "sendTurn",
      "respondToRequest",
      "respondToUserInput",
      "rollbackConversation",
      "stopSession",
    ]) {
      const result = await Effect.runPromise(
        Effect.result(route({ threadId: binding.threadId, operation, allowRecovery: true })),
      );
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { issue: LEGACY_OPENCODE_READ_ONLY_MESSAGE },
      });
    }
    expect(
      await Effect.runPromise(Effect.result(recover({ binding, operation: "replay" }))),
    ).toMatchObject({ _tag: "Failure" });
    expect(lookup).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(binding).toEqual(before);
    expect(await Effect.runPromise(directory.listBindings())).toEqual([before]);
  });
});
