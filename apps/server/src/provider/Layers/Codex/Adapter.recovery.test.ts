import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";

import {
  CodexRpcError,
  CodexSessionUnavailableError,
} from "../../../codex/codexAppServerManager.errors.ts";
import { withTurnStartRecovery } from "../../../orchestration/Layers/ProviderCommandReactorSessionOps.recovery.turnStart.ts";
import type { OrchestrationEngineShape } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ServerConfig } from "../../../startup/config.ts";
import { ServerSettingsService } from "../../../ws/serverSettings.ts";
import type { ProviderServiceShape } from "../../Services/ProviderService.ts";
import { CodexAdapter } from "../../Services/Codex/Adapter.ts";
import { makeCodexAdapterLive } from "./Adapter.ts";
import {
  FakeCodexManager,
  asThreadId,
  providerSessionDirectoryTestLayer,
} from "./Adapter.test.helpers.ts";

function harness(cause: Error) {
  const manager = new FakeCodexManager();
  manager.sendTurnImpl.mockRejectedValueOnce(cause);
  const stopSession = vi.fn(() => Effect.void);
  const dispatch = vi.fn(() => Effect.succeed({ sequence: 1 }));
  const providerService = {
    stopSession,
    listSessions: () => Effect.succeed([]),
    getCapabilities: () => Effect.succeed({ sessionRecovery: "resume-restart" }),
  } as unknown as ProviderServiceShape;
  const layer = makeCodexAdapterLive({ manager }).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  );
  const run = () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const adapter = yield* CodexAdapter;
          const threadId = asThreadId("codex-recovery");
          return yield* withTurnStartRecovery({
            threadId,
            provider: "codex",
            providerService,
            orchestrationEngine: { dispatch } as unknown as OrchestrationEngineShape,
            states: new Map(),
            attempt: (_recovery, phase) => {
              phase.dispatched = true;
              return adapter.sendTurn({ threadId, input: "only send once", attachments: [] });
            },
          }).pipe(Effect.result);
        }).pipe(Effect.provide(layer)),
      ),
    );
  return { manager, stopSession, dispatch, run };
}

describe("Codex adapter delivery certainty through turn-start recovery", () => {
  it("never stops or resends a possibly-applied mutation whose error looks like a context limit", async () => {
    const cause = new CodexRpcError(
      "turn/start",
      7,
      "possibly-applied",
      "maximum context length exceeded after accepting turn",
    );
    const { manager, stopSession, dispatch, run } = harness(cause);
    const result = await run();
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure).toMatchObject({ failureClass: "unsafe-to-replay", cause });
    }
    expect(manager.sendTurnImpl).toHaveBeenCalledOnce();
    expect(stopSession).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("retains the bounded context-limit retry for proven non-delivery", async () => {
    const cause = new CodexRpcError(
      "turn/start",
      7,
      "not-dispatched",
      "maximum context length exceeded in preflight",
    );
    const { manager, stopSession, run } = harness(cause);
    expect((await run())._tag).toBe("Success");
    expect(manager.sendTurnImpl).toHaveBeenCalledTimes(2);
    expect(stopSession).toHaveBeenCalledOnce();
  });

  it("retains recovery for a typed locally missing session before native dispatch", async () => {
    const { manager, stopSession, run } = harness(new CodexSessionUnavailableError("missing", 7));
    expect((await run())._tag).toBe("Success");
    expect(manager.sendTurnImpl).toHaveBeenCalledTimes(2);
    expect(stopSession).toHaveBeenCalledOnce();
  });
});
