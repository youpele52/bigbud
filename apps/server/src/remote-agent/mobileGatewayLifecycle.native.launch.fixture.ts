import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { nativeLeaseLaunchFingerprint } from "./remoteAgentServiceLease.launch.ts";
import type { RemoteAgentServiceLeaseStart } from "./remoteAgentProtocol.serviceLease.ts";
import type { MobileRegistryOwner } from "./remoteAgentInstall.mobile.schema.ts";
import type { MobileAssetsReceiptReference } from "../remote-backend/mobileGatewayAssets.receipt.reference.ts";

/** Controlled wire input only; this guard and executable are never native production inputs. */
export function nativeOwnershipFixtureLaunch(input: {
  readonly owner: MobileRegistryOwner;
  readonly releaseId: string;
  readonly gatewaySha256: string;
  readonly assetsSha256: string;
  readonly stateDir: string;
  readonly epoch: string;
  readonly nonce: string;
  readonly reference: MobileAssetsReceiptReference;
}): RemoteAgentServiceLeaseStart {
  const guard = Buffer.from("controlled-native-guard");
  const binding = {
    authority: input.owner.authority.authorityId,
    installation: input.owner.installationFingerprint,
    nativeEpoch: input.epoch,
    nonce: input.nonce,
    publicationSha256: Buffer.from(input.releaseId.slice("mobile-release:".length), "hex"),
    executableSha256: Buffer.from(input.gatewaySha256, "hex"),
    assetsSha256: Buffer.from(input.assetsSha256, "hex"),
    configurationSha256: new Uint8Array(32),
    guardSha256: createHash("sha256").update(guard).digest(),
  };
  const start = {
    requestId: "fixture",
    binding,
    capability: randomBytes(32),
    guard,
    executable: "/unexecuted-fixture-gateway",
    args: [
      "--assets-dir",
      join(input.stateDir, "remote-mobile-runtime-v1", input.reference.generation),
    ],
    environment: [],
    assetsGeneration: input.reference.generation,
    assetsReceiptSize: input.reference.sizeBytes,
    assetsReceiptSha256: Buffer.from(input.reference.sha256, "hex"),
    assetsArgument: "--assets-dir",
  };
  return {
    ...start,
    binding: {
      ...binding,
      configurationSha256: nativeLeaseLaunchFingerprint(input.stateDir, start),
    },
  };
}
export function nativeOwnershipFixtureController(startedAt: string | null): NodeJS.ProcessEnv {
  const match = /^start-v2:linux:([^:]{1,64}):([0-9]{1,32})$/.exec(startedAt ?? "");
  if (!match) throw Error("Explicit comparable fixture controller required.");
  return {
    BIGBUD_TEST_NATIVE_PID: String(process.pid),
    BIGBUD_TEST_NATIVE_BOOT: match[1],
    BIGBUD_TEST_NATIVE_STARTED: match[2],
  };
}
