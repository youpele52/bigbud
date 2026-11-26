import { decodeMessage } from "../remote-agent/remoteAgentProtocol.codec.wire.ts";
import { invalid, stringValue } from "./sshOwnerPickerProof.codec.wire.ts";

export interface PickerProofWorkspaceReadiness {
  readonly os: "linux" | "darwin";
  readonly architecture: "x86_64" | "amd64" | "arm64" | "aarch64";
}

export function readWorkspaceReadiness(bytes: Uint8Array): PickerProofWorkspaceReadiness {
  if (bytes.byteLength > 64) return invalid();
  let os: string | undefined;
  let architecture: string | undefined;
  decodeMessage(bytes, (field, wire, reader) => {
    if (field === 1 && os === undefined) os = stringValue(wire, reader);
    else if (field === 2 && architecture === undefined) architecture = stringValue(wire, reader);
    else invalid();
  });
  if (
    (os !== "linux" && os !== "darwin") ||
    (architecture !== "x86_64" &&
      architecture !== "amd64" &&
      architecture !== "arm64" &&
      architecture !== "aarch64")
  )
    return invalid();
  return { os, architecture };
}
