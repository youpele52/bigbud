import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { WS_METHODS } from "@bigbud/contracts/constants/websocket.constant.ts";
import {
  RemoteBackendDeploymentError,
  type RemoteBackendDeploymentInput,
} from "@bigbud/contracts/server/remoteBackendDeployment.ts";
import { ServerConfig } from "../startup/config.ts";
import { RemoteBackendDeployment } from "../remote-backend/Services/RemoteBackendDeployment.ts";

/** D7: only the authenticated local (laptop) backend deploys; remote and mobile clients cannot. */
export const makeWsRpcRemoteBackendDeploymentHandlers = Effect.fn(
  "makeWsRpcRemoteBackendDeploymentHandlers",
)(function* () {
  const config = yield* ServerConfig;
  const deployment = yield* Effect.serviceOption(RemoteBackendDeployment);
  const local = config.mode !== "remote" && Boolean(config.authToken);
  return {
    [WS_METHODS.serverSetupRemoteBackend]: (input: RemoteBackendDeploymentInput) =>
      Effect.tryPromise({
        try: (signal) => {
          if (!local || Option.isNone(deployment))
            throw new RemoteBackendDeploymentError({
              code: "unavailable",
              message: "Remote backend deployment requires the authenticated local backend.",
            });
          return deployment.value.setupRemoteBackend(input, signal);
        },
        catch: (error) =>
          Schema.is(RemoteBackendDeploymentError)(error)
            ? error
            : new RemoteBackendDeploymentError({
                code: "unavailable",
                message: "Remote backend deployment failed.",
              }),
      }),
  };
});
