import * as Rpc from "effect/unstable/rpc/Rpc";

import {
  SSH_OWNER_ADMISSION_WS_METHODS,
  SshOwnerAdmissionSnapshot,
  SshOwnerDrainError,
} from "./sshOwnerAdmission";

export const WsServerGetSshOwnerAdmissionRpc = Rpc.make(SSH_OWNER_ADMISSION_WS_METHODS.get, {
  success: SshOwnerAdmissionSnapshot,
  error: SshOwnerDrainError,
});

export const WsServerDrainSshOwnerIdentifiedPanesRpc = Rpc.make(
  SSH_OWNER_ADMISSION_WS_METHODS.drain,
  { success: SshOwnerAdmissionSnapshot, error: SshOwnerDrainError },
);
