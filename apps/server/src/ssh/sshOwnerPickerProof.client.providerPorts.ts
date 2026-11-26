import { opencodeV2BindingIdentity } from "./sshOwnerRemotePath.ts";
import { makePickerProofProductionProxyClient } from "./sshOwnerPickerProof.client.productionProxy.ts";
import type { OpencodeV2ServiceBinding } from "./sshOwnerRemotePath.ts";
import type { PickerProofOwnerOptions } from "./sshOwnerPickerProof.client.types.ts";
import type { PickerProofOperation } from "./sshOwnerPickerProof.codec.ts";
import type { Outcome } from "./sshOwnerPickerProof.codec.outcome.ts";
import type { DevOpencodeV2ServiceRefusal } from "./sshOwnerDevRuntime.providerServices.ts";
import type { PickerProofProductionProxyClient } from "./sshOwnerPickerProof.client.productionProxy.ts";

/**
 * Owner-selected OpenCode port for one launched proof owner.
 *
 * The only remote OpenCode path is the owner's v2 `serve --stdio` lane, whose
 * argv, remote port, listener, forward and per-lease credential all come from
 * the owner; the OpenCode v1 SSH transport is retired. No request chooses it.
 *
 * The v2 lane is exposed as raw owner operations plus its trusted binding; the
 * OpenCode v2 provider layer builds its transport from it, so this SSH layer
 * never depends on provider code.
 *
 * @module sshOwnerPickerProof.client.providerPorts
 */
export interface ProviderServicePortsInput {
  readonly targetId: string | undefined;
  readonly options: Pick<PickerProofOwnerOptions, "opencodeV2Service" | "opencodeV2Refusal">;
  readonly binding: () => { ownerEpoch: Uint8Array; targetGeneration: Uint8Array };
  readonly executeOperation: (operation: PickerProofOperation) => Promise<Outcome>;
}

/** One owner's OpenCode v2 lane: exact target, owner verbs and trusted binding. */
export interface PickerProofOpencodeV2Lane {
  readonly targetId: string;
  readonly client: Pick<
    PickerProofProductionProxyClient,
    "openOpencodeV2" | "opencodeV2Status" | "closeOpencodeV2"
  >;
  readonly binding: () => { ownerEpoch: Uint8Array; targetGeneration: Uint8Array };
  readonly binaryPath: string;
}

export interface ProviderServicePorts {
  readonly opencodeV2Lane?: PickerProofOpencodeV2Lane;
  /** The trusted v2 binding this owner was launched with, if any. */
  readonly opencodeV2Service?: OpencodeV2ServiceBinding;
  /** A configured-but-unusable v2 binding from the profile settings. */
  readonly opencodeV2Refusal?: DevOpencodeV2ServiceRefusal;
}

export function makeProviderServicePorts(input: ProviderServicePortsInput): ProviderServicePorts {
  const { options } = input;
  return {
    ...(options.opencodeV2Service && input.targetId
      ? {
          opencodeV2Lane: {
            targetId: input.targetId,
            client: makePickerProofProductionProxyClient(input.executeOperation),
            binding: input.binding,
            binaryPath: opencodeV2BindingIdentity(options.opencodeV2Service),
          },
        }
      : {}),
    ...(options.opencodeV2Service === undefined
      ? {}
      : { opencodeV2Service: options.opencodeV2Service }),
    ...(options.opencodeV2Refusal === undefined
      ? {}
      : { opencodeV2Refusal: options.opencodeV2Refusal }),
  };
}
