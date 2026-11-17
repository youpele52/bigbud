import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServiceMap from "effect/ServiceMap";
import * as Data from "effect/Data";
import {
  MobileActivationState,
  type MobileActivationAcknowledgement,
  type MobileActivationStatus,
} from "./mobileGatewayActivation.state.ts";
import type { MobileRuntimeRepairReport } from "./mobileGatewayAssets.orphan.ts";

export class MobileGatewayActivationError extends Data.TaggedError("MobileGatewayActivationError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}
export interface RemoteMobileGatewayActivationShape {
  readonly activate: (
    input: unknown,
  ) => Effect.Effect<MobileActivationAcknowledgement, MobileGatewayActivationError>;
  readonly resume: Effect.Effect<MobileActivationAcknowledgement, MobileGatewayActivationError>;
  /** Settles accepted controller work. Unattached/idle success is not native exit evidence. */
  readonly stop: Effect.Effect<void, MobileGatewayActivationError>;
  /** Orchestration phase for owner status; never native readiness or exit evidence. */
  readonly status: Effect.Effect<MobileActivationStatus>;
  /** Orphan runtime-asset GC on the attached controller; `null` when none is attached. */
  readonly repair: Effect.Effect<MobileRuntimeRepairReport | null, MobileGatewayActivationError>;
}
export class RemoteMobileGatewayActivation extends ServiceMap.Service<
  RemoteMobileGatewayActivation,
  RemoteMobileGatewayActivationShape
>()("bigbud/remote-backend/MobileGatewayActivation") {}
const states = new WeakMap<RemoteMobileGatewayActivationShape, MobileActivationState>();
const failure = (cause: unknown) =>
  new MobileGatewayActivationError({
    message: "Mobile gateway activation control is unavailable.",
    cause,
  });

/** Pure construction. No Scope, FS, keys, settings, downloads, consent or process work. */
export const RemoteMobileGatewayActivationLive = Layer.sync(RemoteMobileGatewayActivation, () => {
  const state = new MobileActivationState();
  const service: RemoteMobileGatewayActivationShape = Object.freeze({
    // Ignoring the request's AbortSignal deliberately detaches only its waiter. Actual later
    // controller owns accepted work in the app Scope, not this RPC/connection Scope.
    activate: (input: unknown) =>
      Effect.tryPromise({ try: () => state.activate(input), catch: failure }),
    resume: Effect.tryPromise({ try: () => state.resume(), catch: failure }),
    stop: Effect.tryPromise({ try: () => state.stop(), catch: failure }),
    status: Effect.sync(() => state.status()),
    repair: Effect.tryPromise({ try: () => state.repair(), catch: failure }),
  });
  states.set(service, state);
  return service;
});

/** Internal orchestration state, never publication/lease authority. No JSON object may register it. */
export function registeredMobileGatewayActivationState(
  service: RemoteMobileGatewayActivationShape,
): MobileActivationState {
  const state = states.get(service);
  if (!state) throw Error("Original early mobile activation service is required.");
  return state;
}
