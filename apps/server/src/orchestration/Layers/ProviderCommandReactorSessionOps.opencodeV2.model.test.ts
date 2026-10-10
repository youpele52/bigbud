import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import { MessageId } from "@bigbud/contracts/core/baseSchemas";
import { makeIsolatedOpencodeV2Adapter } from "../../provider/Layers/OpencodeV2/Adapter.execution.ts";
import { withV2RuntimeFixture } from "../../provider/Layers/OpencodeV2/Runtime.fixture.ts";
import { ensureSessionForThread, sendTurnForThread } from "./ProviderCommandReactorSessionOps.ts";
import {
  createdAt,
  makeSettingsHarness,
  threadId,
} from "./ProviderCommandReactorSessionOps.settings.test.helpers.ts";

vi.mock("./ProviderCommandReactorSessionOps.threadContext.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ProviderCommandReactorSessionOps.threadContext.ts")>()),
  resolveAndExportThreadContextPath: () => Effect.void,
}));

it("routes a captured V2 model/variant change through the real adapter without restarting native history", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory }) => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { adapter, runtime: owned } = yield* makeIsolatedOpencodeV2Adapter(runtime.options);
          const h = makeSettingsHarness("opencodeV2");
          const modelSelection = {
            provider: "opencodeV2" as const,
            subProviderID: "synthetic-provider",
            model: "synthetic-model",
          };
          h.updateThread({
            modelSelection,
            worktreePath: directory,
            workspaceExecutionTargetId: "local",
            providerRuntimeExecutionTargetId: "local",
            executionTargetId: "local",
          });
          h.getCapabilities.mockImplementation(() => Effect.succeed(adapter.capabilities));
          h.startSession.mockImplementation((_thread, input) => adapter.startSession(input));
          h.sendTurn.mockImplementation((input) => adapter.sendTurn(input));
          Object.assign(h.services.providerService, { listSessions: adapter.listSessions });
          yield* ensureSessionForThread(h.services)(threadId, createdAt);
          const nativeId = owned.get(threadId).native.id;
          yield* sendTurnForThread(h.services)({
            threadId,
            createdAt,
            messageText: "First routed turn",
            requestMessageId: MessageId.makeUnsafe("routed-first"),
            modelSelection,
          });
          yield* Effect.promise(() =>
            expect.poll(() => owned.get(threadId).terminalDelivered).toBe(true),
          );
          h.settle();
          yield* sendTurnForThread(h.services)({
            threadId,
            createdAt,
            messageText: "Second routed turn",
            requestMessageId: MessageId.makeUnsafe("routed-second"),
            modelSelection: {
              ...modelSelection,
              model: "second-model",
              options: { variant: "precise" },
            },
          });
          yield* Effect.promise(() =>
            expect.poll(() => owned.get(threadId).terminalDelivered).toBe(true),
          );
          expect(adapter.capabilities.sessionModelSwitch).toBe("in-session");
          expect(owned.get(threadId).native.id).toBe(nativeId);
          expect(owned.get(threadId).model).toEqual({
            providerID: "synthetic-provider",
            id: "second-model",
            variant: "precise",
          });
          expect(h.startSession).toHaveBeenCalledTimes(1);
          expect(h.startSessionFresh).not.toHaveBeenCalled();
          expect(h.stopSession).not.toHaveBeenCalled();
          expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(2);
        }),
      ),
    );
  });
});
