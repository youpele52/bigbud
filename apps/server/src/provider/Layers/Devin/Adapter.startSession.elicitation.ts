import type { ProviderUserInputAnswers } from "@bigbud/contracts/orchestration/orchestration.provider.ts";
import type { ProviderRuntimeEvent } from "@bigbud/contracts/orchestration/providerRuntime.events.ts";
import { ApprovalRequestId, RuntimeRequestId } from "@bigbud/contracts/core/baseSchemas.ts";
import type { ThreadId, TurnId } from "@bigbud/contracts/core/baseSchemas.ts";
import { Deferred, Effect, Schema } from "effect";

import type { AcpSessionRuntimeShape } from "../../acp/AcpSessionRuntime.ts";
import {
  DEVIN_ELICITATION_METHOD,
  devinElicitationResult,
  parseDevinElicitation,
} from "./Adapter.elicitation.logic.ts";
import type {
  DevinAdapterLiveOptions,
  DevinEventStamp,
  PendingUserInput,
} from "./Adapter.helpers.ts";
import { PROVIDER } from "./Adapter.helpers.ts";
import { logNative } from "./Adapter.startSession.events.ts";

interface DevinElicitationDeps {
  readonly acp: AcpSessionRuntimeShape;
  readonly threadId: ThreadId;
  readonly sessionEpoch: number;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly nativeEventLogger: DevinAdapterLiveOptions["nativeEventLogger"] | undefined;
  readonly getActiveTurnId: () => TurnId | undefined;
  readonly makeEventStamp: () => Effect.Effect<DevinEventStamp>;
  readonly offerRuntimeEvent: (event: ProviderRuntimeEvent) => Effect.Effect<void>;
}

/**
 * Routes Devin's `ask_user_question` form elicitation through bigbud's native question flow.
 * Unsupported modes (URL) decline so Devin falls back to asking in text instead of hanging.
 */
export function registerDevinElicitationHandler(deps: DevinElicitationDeps) {
  return deps.acp.handleExtRequest(DEVIN_ELICITATION_METHOD, Schema.Unknown, (params) =>
    Effect.gen(function* () {
      yield* logNative(deps, deps.threadId, DEVIN_ELICITATION_METHOD, params);
      const form = parseDevinElicitation(params);
      if (!form) return { action: "decline" } as const;
      const requestId = ApprovalRequestId.makeUnsafe(crypto.randomUUID());
      const runtimeRequestId = RuntimeRequestId.makeUnsafe(requestId);
      const answers = yield* Deferred.make<ProviderUserInputAnswers>();
      deps.pendingUserInputs.set(requestId, { answers });
      return yield* Effect.gen(function* () {
        yield* deps.offerRuntimeEvent({
          type: "user-input.requested",
          ...(yield* deps.makeEventStamp()),
          sessionEpoch: deps.sessionEpoch,
          provider: PROVIDER,
          threadId: deps.threadId,
          turnId: deps.getActiveTurnId(),
          requestId: runtimeRequestId,
          payload: { questions: [...form.questions] },
          raw: { source: "acp.jsonrpc", method: DEVIN_ELICITATION_METHOD, payload: params },
        });
        const resolved = yield* Deferred.await(answers);
        yield* deps.offerRuntimeEvent({
          type: "user-input.resolved",
          ...(yield* deps.makeEventStamp()),
          sessionEpoch: deps.sessionEpoch,
          provider: PROVIDER,
          threadId: deps.threadId,
          turnId: deps.getActiveTurnId(),
          requestId: runtimeRequestId,
          payload: { answers: resolved },
        });
        return devinElicitationResult(form, resolved);
      }).pipe(Effect.ensuring(Effect.sync(() => deps.pendingUserInputs.delete(requestId))));
    }),
  );
}
