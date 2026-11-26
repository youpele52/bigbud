import { SSH_OWNER_ADMISSION_WS_METHODS } from "@bigbud/contracts/server/sshOwnerAdmission.ts";

import type { RpcUnaryMethod } from "./wsRpcClient.types";
import type { WsTransport } from "./wsTransport";

export interface SshOwnerAdmissionRpcMethods {
  readonly getSshOwnerAdmission: RpcUnaryMethod<typeof SSH_OWNER_ADMISSION_WS_METHODS.get>;
  readonly drainSshOwnerIdentifiedPanes: RpcUnaryMethod<
    typeof SSH_OWNER_ADMISSION_WS_METHODS.drain
  >;
}

export function createSshOwnerAdmissionRpcMethods(
  transport: WsTransport,
): SshOwnerAdmissionRpcMethods {
  return {
    getSshOwnerAdmission: () =>
      transport.request((client) => client[SSH_OWNER_ADMISSION_WS_METHODS.get](undefined)),
    drainSshOwnerIdentifiedPanes: () =>
      transport.request((client) => client[SSH_OWNER_ADMISSION_WS_METHODS.drain](undefined)),
  };
}
