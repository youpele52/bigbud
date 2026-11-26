import type {
  ServerListRemoteFoldersInput,
  ServerListRemoteFoldersResult,
} from "@bigbud/contracts/server/server.remoteFolders";
import type { PickerProofOperation } from "./sshOwnerPickerProof.codec.ts";
import type { Outcome } from "./sshOwnerPickerProof.codec.outcome.ts";
import { PickerProofOwnerError } from "./sshOwnerPickerProof.codec.wire.ts";

type Execute = (
  operation: PickerProofOperation,
  beforeDispatch?: (id: Uint8Array) => void,
) => Promise<Exclude<Outcome, { kind: "error" }>>;
export type SendPickerCancel = (id: Uint8Array) => void;

export interface PickerProofListClient {
  listRemoteFolders(input: ServerListRemoteFoldersInput): Promise<ServerListRemoteFoldersResult>;
  listCancellableRemoteFolders(
    input: ServerListRemoteFoldersInput,
    signal: AbortSignal,
  ): Promise<ServerListRemoteFoldersResult>;
}

export function makePickerProofListClient(
  targetId: string,
  execute: Execute,
  sendCancel?: SendPickerCancel,
): PickerProofListClient {
  const invalid = () => {
    throw new PickerProofOwnerError("invalidOperands");
  };
  const list = async (
    input: ServerListRemoteFoldersInput,
    beforeDispatch?: (id: Uint8Array) => void,
  ) => {
    if (
      input.executionTargetId !== targetId ||
      (input.path !== undefined &&
        (Buffer.byteLength(input.path) > 4096 || input.path.includes("\0")))
    )
      return invalid();
    const outcome = await execute({ kind: "listFolders", path: input.path }, beforeDispatch);
    if (outcome.kind !== "folders") throw new PickerProofOwnerError("protocolError");
    return outcome.value;
  };
  return {
    listRemoteFolders: (input) => list(input),
    listCancellableRemoteFolders: (input, signal) =>
      withPickerReadCancellation(signal, sendCancel, "listCancelled", (beforeDispatch) =>
        list(input, beforeDispatch),
      ),
  };
}

export async function withPickerReadCancellation<A>(
  signal: AbortSignal,
  sendCancel: SendPickerCancel | undefined,
  code: "listCancelled" | "healthCancelled",
  submit: (beforeDispatch: (id: Uint8Array) => void) => Promise<A>,
): Promise<A> {
  if (sendCancel === undefined) throw new PickerProofOwnerError("operationDenied");
  const cancelled = () => {
    throw new PickerProofOwnerError(code);
  };
  if (signal.aborted) return cancelled();
  let dispatched: Uint8Array | undefined;
  const abort = () => {
    if (dispatched) sendCancel(dispatched);
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    return await submit((id) => {
      if (signal.aborted) cancelled();
      dispatched = id;
    });
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
