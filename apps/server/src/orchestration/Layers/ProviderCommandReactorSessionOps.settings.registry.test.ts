import type { ProviderKind } from "@bigbud/contracts";
import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";

import { makeProviderAdapterRegistryLive } from "../../provider/Layers/ProviderAdapterRegistry.ts";
import { makeFakeCodexAdapter } from "../../provider/Layers/ProviderService.test.helpers.ts";
import { ClaudeAdapter } from "../../provider/Services/Claude/Adapter.ts";
import { CodexAdapter } from "../../provider/Services/Codex/Adapter.ts";
import { CopilotAdapter } from "../../provider/Services/Copilot/Adapter.ts";
import { CursorAdapter } from "../../provider/Services/Cursor/Adapter.ts";
import { DevinAdapter } from "../../provider/Services/Devin/Adapter.ts";
import { KilocodeAdapter } from "../../provider/Services/Kilocode/Adapter.ts";
import { OpencodeAdapter } from "../../provider/Services/Opencode/Adapter.ts";
import { PiAdapter } from "../../provider/Services/Pi/Adapter.ts";
import { ProviderAdapterRegistry } from "../../provider/Services/ProviderAdapterRegistry.ts";
import { sendTurnForThread } from "./ProviderCommandReactorSessionOps.ts";
import {
  createdAt,
  makeSettingsHarness,
  threadId,
} from "./ProviderCommandReactorSessionOps.settings.test.helpers.ts";

vi.mock("./ProviderCommandReactorSessionOps.threadContext.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ProviderCommandReactorSessionOps.threadContext.ts")>()),
  resolveAndExportThreadContextPath: () => Effect.void,
}));

const adapter = <P extends ProviderKind>(provider: P) => ({
  ...makeFakeCodexAdapter(provider).adapter,
  provider,
});
// Enumerate the production registry rather than duplicating its provider list
// in the assertions. SDK processes are deliberately replaced with test adapters.
const registryLayer = makeProviderAdapterRegistryLive({
  optionalRegistrations: [{ provider: "cliProxy", service: adapter("cliProxy") }],
}).pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(CodexAdapter, adapter("codex")),
      Layer.succeed(ClaudeAdapter, adapter("claudeAgent")),
      Layer.succeed(CopilotAdapter, adapter("copilot")),
      Layer.succeed(CursorAdapter, adapter("cursor")),
      Layer.succeed(DevinAdapter, adapter("devin")),
      Layer.succeed(KilocodeAdapter, adapter("kilocode")),
      Layer.succeed(OpencodeAdapter, adapter("opencode")),
      Layer.succeed(PiAdapter, adapter("pi")),
    ),
  ),
);
const providers = await Effect.runPromise(
  Effect.gen(function* () {
    const registry = yield* ProviderAdapterRegistry;
    return yield* registry.listProviders();
  }).pipe(Effect.provide(registryLayer)),
);

describe("registered provider captured-settings mapping", () => {
  it.each(providers)(
    "maps both runtime modes and coherent turn settings for %s",
    async (provider) => {
      for (const runtimeMode of ["approval-required", "full-access"] as const) {
        const h = makeSettingsHarness(provider);
        h.updateThread({
          runtimeMode: runtimeMode === "full-access" ? "approval-required" : "full-access",
        });
        const modelSelection = { provider, model: "accepted-model" };
        await Effect.runPromise(
          sendTurnForThread(h.services)({
            threadId,
            createdAt,
            messageText: "Registry mapping",
            runtimeMode,
            modelSelection,
            interactionMode: "plan",
          }),
        );
        expect(h.startSession.mock.calls[0]?.[1]).toMatchObject({ runtimeMode, modelSelection });
        expect(h.sendTurn.mock.calls[0]?.[0]).toMatchObject({
          modelSelection,
          interactionMode: "plan",
          input: expect.stringContaining(`- runtime: ${runtimeMode}`),
        });
        expect(h.sendTurn.mock.calls[0]?.[0].input).toContain("- model: accepted-model");
        expect(h.thread.session?.runtimeMode).toBe(runtimeMode);
        expect(h.thread.runtimeMode).not.toBe(runtimeMode);
      }
    },
  );
});
