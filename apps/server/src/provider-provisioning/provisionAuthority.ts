/**
 * Who may run the provider provision action (WP-5C), following the WP-4C setup-authority
 * pattern (`remote-backend/runtimeUpdate.authority.ts`).
 *
 * - Remote mode: only D10 setup authority, i.e. the authenticated remote client socket
 *   (the SSH-relayed laptop). Paired mobile viewers use a separate router and RPC group
 *   without provisioning RPCs, and a forged header never matches the per-route capability.
 * - Desktop/web: the existing local path, the same trusted local presence that already guards
 *   the Copilot runtime install RPC.
 */
import { randomUUID } from "node:crypto";
import { ProviderProvisioningError } from "@bigbud/contracts/server/providerProvisioning.ts";
import { ProviderProvisioningSetupAuthority } from "@bigbud/contracts/server/rpc.providerProvisioning.ts";
import { Effect, Layer, Option } from "effect";
import { Headers } from "effect/unstable/http";

import {
  grantsRuntimeUpdateSetupAuthority,
  type RuntimeUpdateConnection,
} from "../remote-backend/runtimeUpdate.authority.ts";

const PROVISIONING_AUTHORITY_HEADER = "x-bigbud-provider-provisioning-authority";

export interface ProvisioningConnection extends RuntimeUpdateConnection {
  /** Desktop/web trusted local presence (auth token or same-origin), as for retention. */
  readonly trustedLocal: boolean;
}

export function grantsProviderProvisioning(connection: ProvisioningConnection): boolean {
  return connection.mode === "remote"
    ? grantsRuntimeUpdateSetupAuthority(connection)
    : connection.trustedLocal;
}

export function makeProviderProvisioningAuthority(capability: string = randomUUID()) {
  const authorizeHeaders = (
    headers: Headers.Headers,
    connection: ProvisioningConnection,
  ): Headers.Headers => {
    const sanitized = Headers.remove(headers, PROVISIONING_AUTHORITY_HEADER);
    return grantsProviderProvisioning(connection)
      ? Headers.set(sanitized, PROVISIONING_AUTHORITY_HEADER, capability)
      : sanitized;
  };
  const layer = Layer.succeed(ProviderProvisioningSetupAuthority, (effect, options) =>
    Option.contains(Headers.get(options.headers, PROVISIONING_AUTHORITY_HEADER), capability)
      ? effect
      : Effect.fail(
          new ProviderProvisioningError({
            code: "unauthorized",
            message:
              "Provider provisioning requires setup authority from the SSH-relayed laptop client.",
          }),
        ),
  );
  return { authorizeHeaders, layer };
}
