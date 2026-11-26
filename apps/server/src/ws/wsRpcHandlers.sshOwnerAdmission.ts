import {
  SSH_OWNER_ADMISSION_WS_METHODS,
  SshOwnerDrainError,
  type SshOwnerAdmissionSnapshot,
} from "@bigbud/contracts/server/sshOwnerAdmission.ts";
import * as Effect from "effect/Effect";

import { observeRpcEffect } from "../observability/RpcInstrumentation.ts";
import { readSshOwnerAdmission } from "../ssh/sshOwnerProductionComposition.ts";
import {
  drainSshOwnerIdentifiedPanes,
  listSshOwnerIdentifiedPanes,
  type SshOwnerExplicitDrainError,
} from "../ssh/sshOwnerProductionStartup.ts";

const toDrainError = (error: SshOwnerExplicitDrainError) =>
  new SshOwnerDrainError({ code: error.reason, message: error.message });

/** The current admission; a fence lists the host's managed SSH panes for consent. */
const snapshot = Effect.gen(function* () {
  const admission = readSshOwnerAdmission();
  if (admission.kind !== "closed") return { state: admission.kind } as SshOwnerAdmissionSnapshot;
  const error = admission.error;
  if (error.code === "sshOwnerUnavailable")
    return { state: "unavailable", reason: error.reason, message: error.message } as const;
  const listed = yield* Effect.result(listSshOwnerIdentifiedPanes());
  return {
    state: "fenced",
    reason: error.reason,
    message: error.message,
    panes:
      listed._tag === "Success"
        ? listed.success.map((pane) => ({
            identity: pane.identity,
            threadId: pane.threadId,
            paneId: pane.paneId,
          }))
        : [],
    ...(listed._tag === "Failure" ? { listError: listed.failure.message } : {}),
  } as const;
});

/** Read and explicit-drain handlers; reading never drains. */
export const makeWsRpcSshOwnerAdmissionHandlers = () => ({
  [SSH_OWNER_ADMISSION_WS_METHODS.get]: () =>
    observeRpcEffect(SSH_OWNER_ADMISSION_WS_METHODS.get, snapshot, {
      "rpc.aggregate": "server",
    } as const),
  [SSH_OWNER_ADMISSION_WS_METHODS.drain]: () =>
    observeRpcEffect(
      SSH_OWNER_ADMISSION_WS_METHODS.drain,
      drainSshOwnerIdentifiedPanes().pipe(
        Effect.mapError(toDrainError),
        Effect.andThen(() => snapshot),
      ),
      { "rpc.aggregate": "server" } as const,
    ),
});
