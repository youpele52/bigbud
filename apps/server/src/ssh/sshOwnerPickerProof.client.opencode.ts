import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import type {
  OpencodeOwnerExit,
  OpencodeSshOwner,
} from "../provider/Layers/Opencode/ServerManager.owner.ts";
import type {
  ProofOpencodeOperation,
  ProofOpencodeState,
} from "./sshOwnerPickerProof.codec.opencode.ts";
import type { PickerProofProviderFixture } from "./sshOwnerPickerProof.codec.provider.ts";
import { PickerProofOwnerError } from "./sshOwnerPickerProof.codec.wire.ts";

const POLL_MS = 33;

type Execute = (
  operation: ProofOpencodeOperation,
  beforeDispatch?: () => void,
) => Promise<ProofOpencodeState>;

function beforeOpenFailure(error: unknown): boolean {
  return error instanceof PickerProofOwnerError && beforeOpenCodes.has(error.code);
}

const beforeOpenCodes = new Set([
  "operationDenied",
  "invalidOperands",
  "trustRequired",
  "targetDisconnected",
  "configUnsupported",
  "staleGeneration",
]);

export function makeProofOpencodeOwner(
  targetId: string,
  fixture: PickerProofProviderFixture | undefined,
  /** Configured remote executable for the product OpenCode service, when bound. */
  serviceBinary: string | undefined,
  binding: () => { ownerEpoch: Uint8Array; targetGeneration: Uint8Array },
  execute: Execute,
): OpencodeSshOwner {
  return {
    startProvider(request) {
      const service =
        serviceBinary !== undefined &&
        request.provider === "opencode" &&
        request.executionTargetId === targetId &&
        request.binaryPath === serviceBinary
          ? {
              threadId: request.threadId,
              sessionEpoch: request.sessionEpoch,
              cwd: request.cwd,
            }
          : undefined;
      if (
        !service &&
        (!fixture ||
          request.provider !== "opencode" ||
          request.executionTargetId !== targetId ||
          request.threadId !== fixture.threadId ||
          request.sessionEpoch !== fixture.sessionEpoch ||
          request.cwd !== fixture.cwd ||
          request.binaryPath !== fixture.binaryPath)
      )
        throw new PickerProofOwnerError("operationDenied");
      const token = randomBytes(32);
      const { ownerEpoch, targetGeneration } = binding();
      const lease = {
        ownerEpoch: Buffer.from(ownerEpoch).toString("hex"),
        targetGeneration: Buffer.from(targetGeneration).toString("hex"),
        leaseId: token.toString("hex"),
      };
      const ready = Promise.withResolvers<{ localPort: number }>();
      const exit = Promise.withResolvers<OpencodeOwnerExit>();
      const closed = Promise.withResolvers<void>();
      for (const promise of [ready.promise, exit.promise, closed.promise])
        void promise.catch(() => undefined);
      let cancelled = false;
      let dispatched = false;
      let closeSent = false;
      const correlate = (state: ProofOpencodeState) => {
        if (!Buffer.from(state.lease).equals(token))
          throw new PickerProofOwnerError("protocolError");
        return state;
      };
      const run = async () => {
        let state: ProofOpencodeState;
        try {
          const operation: ProofOpencodeOperation = service
            ? { kind: "proofOpencodeOpen", lease: token, serviceScope: service }
            : {
                kind: "proofOpencodeOpen",
                lease: token,
                ...(fixture as PickerProofProviderFixture),
              };
          state = correlate(
            await execute(operation, () => {
              if (cancelled || !Buffer.from(binding().targetGeneration).equals(targetGeneration))
                throw new PickerProofOwnerError("operationDenied");
              dispatched = true;
            }),
          );
        } catch (cause) {
          if (!dispatched || beforeOpenFailure(cause)) closed.resolve();
          throw cause;
        }
        for (;;) {
          switch (state.phase) {
            case "ready":
              if (!cancelled) ready.resolve({ localPort: state.localPort });
              break;
            case "starting":
            case "closing":
              break;
            case "exited":
              closed.resolve();
              exit.resolve({ kind: "exited", code: state.exitCode });
              ready.reject(new PickerProofOwnerError("transportLost"));
              return;
            case "closed":
            case "lost":
            case "rejected":
              closed.resolve();
              throw new PickerProofOwnerError(
                state.phase === "rejected" ? "operationDenied" : "transportLost",
              );
            case "unconfirmed":
              throw new PickerProofOwnerError("outcomeUnknown");
          }
          if (cancelled && !closeSent) {
            closeSent = true;
            state = correlate(await execute({ kind: "proofOpencodeClose", lease: token }));
          } else {
            await delay(POLL_MS);
            state = correlate(await execute({ kind: "proofOpencodeStatus", lease: token }));
          }
        }
      };
      void run().catch((cause: unknown) => {
        ready.reject(cause);
        exit.reject(cause);
        closed.reject(cause);
      });
      return {
        lease,
        ready: ready.promise,
        exit: exit.promise,
        cancel() {
          cancelled = true;
          return closed.promise;
        },
      };
    },
  };
}
