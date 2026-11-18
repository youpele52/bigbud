import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { WS_METHODS } from "@bigbud/contracts/constants/websocket.constant.ts";
import {
  RemoteRuntimeUpdateError,
  type RemoteRuntimeUpdateCancelInput,
  type RemoteRuntimeUpdateConsentInput,
  type RemoteRuntimeUpdateRequestInput,
  type RemoteRuntimeUpdateStatusInput,
} from "@bigbud/contracts/server/remoteBackendUpdate.ts";
import {
  RemoteRuntimeUpdate,
  type RemoteRuntimeUpdateShape,
} from "../remote-backend/Services/RemoteRuntimeUpdate.ts";

/**
 * Runtime update RPCs (WP-4C). Setup authority (D10) is enforced before these handlers by the
 * `RemoteRuntimeUpdateSetupAuthority` RPC middleware; mobile's RPC group has none of them.
 */
export const makeWsRpcRemoteBackendUpdateHandlers = Effect.fn(
  "makeWsRpcRemoteBackendUpdateHandlers",
)(function* () {
  const service = yield* Effect.serviceOption(RemoteRuntimeUpdate);
  const run = <A>(
    use: (update: RemoteRuntimeUpdateShape) => Effect.Effect<A, RemoteRuntimeUpdateError>,
  ) =>
    Option.isSome(service)
      ? use(service.value)
      : Effect.fail(
          new RemoteRuntimeUpdateError({
            code: "unavailable",
            message: "Runtime updates are not available on this backend.",
          }),
        );
  return {
    [WS_METHODS.serverRequestRemoteRuntimeUpdate]: (input: RemoteRuntimeUpdateRequestInput) =>
      run((update) => update.request(input)),
    [WS_METHODS.serverGetRemoteRuntimeUpdateStatus]: (input: RemoteRuntimeUpdateStatusInput) =>
      run((update) => update.status(input)),
    [WS_METHODS.serverConsentRemoteRuntimeUpdateInterruption]: (
      input: RemoteRuntimeUpdateConsentInput,
    ) => run((update) => update.consent(input)),
    [WS_METHODS.serverCancelRemoteRuntimeUpdate]: (input: RemoteRuntimeUpdateCancelInput) =>
      run((update) => update.cancel(input)),
  };
});
