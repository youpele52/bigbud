import { createHash } from "node:crypto";
import { nativeLeaseLaunchFingerprint } from "./remoteAgentServiceLease.launch.ts";
import type {
  RemoteAgentServiceLeaseStart as Start,
  RemoteAgentServiceLeaseResponse as Response,
} from "./remoteAgentProtocol.serviceLease.ts";
export const stateDir = "/private/state";
export function launch(nonce = "original-attempt"): Start {
  const guard = Buffer.from("fixture-guard");
  const binding: NonNullable<Start["binding"]> = {
    authority: "a".repeat(32),
    installation: `sha256:${"b".repeat(64)}`,
    nativeEpoch: "epoch",
    nonce,
    publicationSha256: new Uint8Array(32).fill(1),
    executableSha256: new Uint8Array(32).fill(2),
    assetsSha256: new Uint8Array(32).fill(3),
    configurationSha256: new Uint8Array(32),
    guardSha256: createHash("sha256").update(guard).digest(),
  };
  const input = {
    requestId: "ignored",
    binding,
    capability: new Uint8Array(32).fill(7),
    guard,
    executable: "/private/gateway",
    args: ["--assets-dir", `${stateDir}/remote-mobile-runtime-v1/assets-${"0".repeat(32)}`],
    environment: [{ name: "PRIVATE_CREDENTIAL", value: "memory-only-secret" }],
    assetsGeneration: `assets-${"0".repeat(32)}`,
    assetsReceiptSize: 1234,
    assetsReceiptSha256: new Uint8Array(32).fill(6),
    assetsArgument: "--assets-dir",
  };
  return {
    ...input,
    binding: { ...binding, configurationSha256: nativeLeaseLaunchFingerprint(stateDir, input) },
  };
}
export function response(input: Start, generation = 1): Response {
  return {
    requestId: "reply",
    accepted: true,
    state: "spawned",
    errorCode: "",
    binding: input.binding,
    generation,
    originalChildPid: 43,
    bootstrap: [],
    originalController: { pid: 42, boot: "boot", started: "100" },
    currentController: { pid: 42, boot: "boot", started: "100" },
    previousController: undefined,
  };
}

export function retainedReference(input: Start) {
  if (!input.binding) throw Error("Fixture binding missing.");
  return {
    binding: input.binding,
    capability: input.capability,
    assetsGeneration: input.assetsGeneration,
    assetsReceiptSize: input.assetsReceiptSize,
    assetsReceiptSha256: input.assetsReceiptSha256,
    assetsArgument: input.assetsArgument,
  };
}
