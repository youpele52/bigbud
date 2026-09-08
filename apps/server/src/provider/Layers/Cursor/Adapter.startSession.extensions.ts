import type { ProviderRuntimeEvent } from "@bigbud/contracts/orchestration/providerRuntime.events.ts";
import type { ProviderUserInputAnswers } from "@bigbud/contracts/orchestration/orchestration.provider.ts";
import { ApprovalRequestId, RuntimeRequestId } from "@bigbud/contracts/core/baseSchemas.ts";
import type { ThreadId, TurnId } from "@bigbud/contracts/core/baseSchemas.ts";
import { Deferred, Effect } from "effect";
import type * as EffectAcpErrors from "effect-acp/errors";

import type { AcpSessionRuntimeShape } from "../../acp/AcpSessionRuntime.ts";
import {
  buildCursorAskQuestionResponse,
  buildCursorCreatePlanAcceptedResponse,
  CursorAskQuestionRequest,
  CursorCreatePlanRequest,
  CursorUpdateTodosRequest,
  extractAskQuestions,
  extractPlanMarkdown,
  extractTodosAsPlan,
} from "../../acp/CursorAcpExtension.ts";
import {
  type CursorEventStamp,
  type CursorUserInputResolution,
  type CursorAdapterLiveOptions,
  type CursorSessionContext,
  type PendingUserInput,
} from "./Adapter.helpers.ts";
import { emitPlanUpdate, logNative } from "./Adapter.startSession.events.ts";
import { PROVIDER } from "./Provider.shared.ts";

interface CursorExtensionRegistrationDeps {
  readonly acp: AcpSessionRuntimeShape;
  readonly nativeEventLogger: CursorAdapterLiveOptions["nativeEventLogger"] | undefined;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly sessionEpoch: number;
  readonly threadId: ThreadId;
  readonly getSessionContext: () => CursorSessionContext | undefined;
  readonly makeEventStamp: () => Effect.Effect<CursorEventStamp>;
  readonly offerRuntimeEvent: (event: ProviderRuntimeEvent) => Effect.Effect<void>;
}

function activeTurnId(deps: CursorExtensionRegistrationDeps): TurnId | undefined {
  return deps.getSessionContext()?.activeTurnId;
}

function emptyAnswers(): ProviderUserInputAnswers {
  return {};
}

function registerAskQuestionHandler(deps: CursorExtensionRegistrationDeps) {
  return deps.acp.handleExtRequest("cursor/ask_question", CursorAskQuestionRequest, (params) =>
    Effect.gen(function* () {
      yield* logNative(deps, deps.threadId, "cursor/ask_question", params);
      const requestId = ApprovalRequestId.makeUnsafe(crypto.randomUUID());
      const runtimeRequestId = RuntimeRequestId.makeUnsafe(requestId);
      const resolution = yield* Deferred.make<CursorUserInputResolution>();
      deps.pendingUserInputs.set(requestId, { resolution });

      return yield* Effect.gen(function* () {
        yield* deps.offerRuntimeEvent({
          type: "user-input.requested",
          ...(yield* deps.makeEventStamp()),
          sessionEpoch: deps.sessionEpoch,
          provider: PROVIDER,
          threadId: deps.threadId,
          turnId: activeTurnId(deps),
          requestId: runtimeRequestId,
          payload: { questions: extractAskQuestions(params) },
          raw: {
            source: "acp.cursor.extension",
            method: "cursor/ask_question",
            payload: params,
          },
        });

        const resolved = yield* Deferred.await(resolution);
        const answers = resolved.outcome === "answered" ? resolved.answers : emptyAnswers();
        yield* deps.offerRuntimeEvent({
          type: "user-input.resolved",
          ...(yield* deps.makeEventStamp()),
          sessionEpoch: deps.sessionEpoch,
          provider: PROVIDER,
          threadId: deps.threadId,
          turnId: activeTurnId(deps),
          requestId: runtimeRequestId,
          payload: { answers },
        });

        return buildCursorAskQuestionResponse({ request: params, resolution: resolved });
      }).pipe(Effect.ensuring(Effect.sync(() => deps.pendingUserInputs.delete(requestId))));
    }),
  );
}

function registerCreatePlanHandler(deps: CursorExtensionRegistrationDeps) {
  return deps.acp.handleExtRequest("cursor/create_plan", CursorCreatePlanRequest, (params) =>
    Effect.gen(function* () {
      yield* logNative(deps, deps.threadId, "cursor/create_plan", params);
      yield* deps.offerRuntimeEvent({
        type: "turn.proposed.completed",
        ...(yield* deps.makeEventStamp()),
        sessionEpoch: deps.sessionEpoch,
        provider: PROVIDER,
        threadId: deps.threadId,
        turnId: activeTurnId(deps),
        payload: { planMarkdown: extractPlanMarkdown(params) },
        raw: {
          source: "acp.cursor.extension",
          method: "cursor/create_plan",
          payload: params,
        },
      });
      return buildCursorCreatePlanAcceptedResponse();
    }),
  );
}

function registerUpdateTodosHandler(deps: CursorExtensionRegistrationDeps) {
  return deps.acp.handleExtNotification("cursor/update_todos", CursorUpdateTodosRequest, (params) =>
    Effect.gen(function* () {
      yield* logNative(deps, deps.threadId, "cursor/update_todos", params);
      const context = deps.getSessionContext();
      if (context) {
        yield* emitPlanUpdate(
          deps,
          context,
          extractTodosAsPlan(params),
          params,
          "acp.cursor.extension",
          "cursor/update_todos",
        );
      }
    }),
  );
}

export function registerCursorExtensionHandlers(
  deps: CursorExtensionRegistrationDeps,
): Effect.Effect<void, EffectAcpErrors.AcpError> {
  return Effect.gen(function* () {
    yield* registerAskQuestionHandler(deps);
    yield* registerCreatePlanHandler(deps);
    yield* registerUpdateTodosHandler(deps);
  });
}
