import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { RemoteAgentRuntimeOwnersLive } from "./persistence/Layers/RemoteAgentRuntimeBindings.ts";
import { makeNativeMobileActivationController } from "./remote-backend/mobileGatewayActivation.controller.ts";
import {
  RemoteMobileNativeInputs,
  RemoteMobileNativeInputsLive,
  type RemoteMobileNativeInputsValue,
} from "./remote-backend/mobileGatewayActivation.inputs.ts";
import {
  RemoteMobileGatewayActivation,
  registeredMobileGatewayActivationState,
} from "./remote-backend/mobileGatewayActivation.service.ts";

/**
 * Attach the native controller for the app's lifetime and run successor recovery once. Release
 * retires it through the activation state: a pending stop settles first, then the controller
 * detaches and awaits its session.
 *
 * `RemoteAgentRuntimeOwnersLive` is the same layer value the local-supervisor PTY and managed
 * agent layers provide, so the app's single layer build memoises one owners store (one in-memory
 * reservation table) instead of constructing a duplicate.
 */
const attachNativeMobileActivation = (inputs: RemoteMobileNativeInputsValue) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const service = yield* RemoteMobileGatewayActivation;
      const controller = yield* makeNativeMobileActivationController(inputs);
      const log = Effect.runForkWith(yield* Effect.services<never>());
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const state = registeredMobileGatewayActivationState(service);
          const retire = state.attach(controller);
          // Adopt at most one predecessor's original once per attach. Its settlement lives in the
          // controller's phase; this waiter only logs a refused or uncertain recovery.
          void state
            .resume()
            .catch((cause: unknown) =>
              log(Effect.logWarning("Mobile successor recovery is uncertain.", cause)),
            );
          return retire;
        }),
        (retire) =>
          Effect.tryPromise(retire).pipe(
            Effect.ignoreCause({ log: true }),
            Effect.withSpan("RemoteMobileActivation.retire"),
          ),
      );
    }),
  ).pipe(Layer.provide(RemoteAgentRuntimeOwnersLive));

/** Default-off: absent proof inputs attach nothing and perform no FS, IO or channel work. */
export const RemoteMobileActivationAttachLive = Layer.unwrap(
  Effect.gen(function* () {
    const inputs = yield* RemoteMobileNativeInputs;
    return Option.isSome(inputs) ? attachNativeMobileActivation(inputs.value) : Layer.empty;
  }),
);

export const RemoteMobileActivationLive = RemoteMobileActivationAttachLive.pipe(
  Layer.provide(RemoteMobileNativeInputsLive),
);
