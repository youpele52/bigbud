import {
  BACKEND_DRAIN_WS_METHODS,
  BackendDrainConsentError,
  type BackendDrainConsentSnapshot,
  type BackendDrainDecisionResult,
  type DecideBackendDrainInput,
} from "@bigbud/contracts/server/backendDrain.ts";
import * as Effect from "effect/Effect";

import {
  decideBackendDrain,
  pendingBackendDrain,
  wasBackendDrainDecided,
} from "../startup/backendDrain.consent.ts";
import { observeRpcEffect } from "../observability/RpcInstrumentation.ts";

const unavailable = () =>
  Effect.fail(
    new BackendDrainConsentError({
      code: "unavailable",
      message: "No backend drain consent is pending on this server.",
    }),
  );

const snapshot = (): BackendDrainConsentSnapshot | null => {
  const pending = pendingBackendDrain();
  if (!pending) return null;
  return {
    drainId: pending.drainId,
    deadlineAt: pending.deadlineAt,
    panes: pending.panes.map((pane) => ({
      paneId: pane.paneId,
      threadId: pane.threadId,
      terminalId: pane.paneId.split(":")[1] ?? pane.paneId,
      threadTitle: pane.threadTitle,
      paneTitle: pane.title,
      surface:
        pane.surface === "direct-ssh"
          ? "direct-ssh"
          : pane.surface === "remote-agent"
            ? "remote-agent"
            : "local",
      keepMode: pane.keepMode,
    })),
  };
};

/** Reconnect reads the current pending snapshot; no new drain is started. */
export const makeWsRpcBackendDrainHandlers = () => ({
  [BACKEND_DRAIN_WS_METHODS.get]: () =>
    observeRpcEffect(BACKEND_DRAIN_WS_METHODS.get, Effect.sync(snapshot), {
      "rpc.aggregate": "server",
    } as const),
  [BACKEND_DRAIN_WS_METHODS.decide]: (input: DecideBackendDrainInput) =>
    observeRpcEffect(
      BACKEND_DRAIN_WS_METHODS.decide,
      Effect.suspend((): Effect.Effect<BackendDrainDecisionResult, BackendDrainConsentError> => {
        const pending = pendingBackendDrain();
        if (!pending || pending.drainId !== input.drainId)
          return wasBackendDrainDecided(input.drainId)
            ? Effect.succeed({ status: "already-decided" })
            : unavailable();
        const mapped =
          input.decision === "cancel"
            ? ({ kind: "cancel" } as const)
            : ({
                kind: "proceed",
                choice: input.decision === "save-and-close" ? "save-and-close" : "drain-now",
              } as const);
        const result = decideBackendDrain(input.drainId, mapped);
        if (result === "refused") return Effect.succeed({ status: "already-decided" });
        return Effect.succeed({ status: "accepted", decision: input.decision });
      }),
      { "rpc.aggregate": "server" } as const,
    ),
});
