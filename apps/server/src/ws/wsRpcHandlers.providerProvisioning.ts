import * as Effect from "effect/Effect";
import { WS_METHODS } from "@bigbud/contracts/constants/websocket.constant.ts";
import type {
  ProviderProvisionInput,
  ProviderProvisioningStatusInput,
} from "@bigbud/contracts/server/providerProvisioning.ts";

import {
  providerProvisioningStatus,
  provisionProvider,
} from "../provider-provisioning/provision.ts";
import { makeLiveProvisioningEnvironment } from "../provider-provisioning/provision.live.ts";
import type { WsRpcContext } from "./wsRpcContext.ts";

/**
 * Provider provisioning RPCs (WP-5C). The provision action runs only after the
 * `ProviderProvisioningSetupAuthority` RPC middleware admitted the connection; status is a
 * read that never installs or starts anything. Mobile's RPC group has neither.
 */
export function makeWsRpcProviderProvisioningHandlers(context: WsRpcContext) {
  const live = makeLiveProvisioningEnvironment({
    mode: context.config.mode,
    serverSettings: context.serverSettings,
    providerRegistry: context.providerRegistry,
  });
  return {
    [WS_METHODS.serverGetProviderProvisioningStatus]: (input: ProviderProvisioningStatusInput) =>
      Effect.gen(function* () {
        const { environment, servicePath } = yield* live;
        const providers = yield* providerProvisioningStatus(environment, input.provider);
        return { servicePath, providers };
      }),
    [WS_METHODS.serverProvisionProvider]: (input: ProviderProvisionInput) =>
      Effect.gen(function* () {
        const { environment } = yield* live;
        return yield* provisionProvider(input.provider, environment);
      }),
  };
}
