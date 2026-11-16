import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import type { RemoteAgentServiceLeaseStart } from "./remoteAgentProtocol.serviceLease.ts";
import {
  nativeLeaseLaunchFingerprint,
  type NativeLeaseLaunchFingerprintInput,
} from "./remoteAgentServiceLease.launch.ts";
it("matches native original launch/resource fingerprint and preserves empty argv", () => {
  const value: {
    stateDir: string;
    guardUtf8: string;
    executable: string;
    args: string[];
    environment: Array<{ name: string; value: string }>;
    assetsGeneration: string;
    assetsReceiptSize: number;
    assetsReceiptSha256: string;
    assetsArgument: string;
    sha256: string;
  } = JSON.parse(
    readFileSync(
      new URL(
        "../../../../protocol/remote-agent/service_lease.launch.golden.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const input: RemoteAgentServiceLeaseStart = {
    ...value,
    requestId: "unused",
    capability: new Uint8Array(32),
    guard: Buffer.from(value.guardUtf8),
    assetsReceiptSha256: Buffer.from(value.assetsReceiptSha256, "hex"),
    binding: {
      authority: "a".repeat(32),
      installation: `sha256:${"b".repeat(64)}`,
      nativeEpoch: "epoch",
      nonce: "nonce",
      publicationSha256: new Uint8Array(32),
      executableSha256: new Uint8Array(32).fill(2),
      assetsSha256: new Uint8Array(32),
      configurationSha256: new Uint8Array(32),
      guardSha256: new Uint8Array(32),
    },
  };
  const digest = () =>
    Buffer.from(nativeLeaseLaunchFingerprint(value.stateDir, input)).toString("hex");
  expect(digest()).toBe(value.sha256);
  const launchOnly: NativeLeaseLaunchFingerprintInput = {
    executable: input.executable,
    args: input.args,
    environment: input.environment,
    guard: input.guard,
    assetsGeneration: input.assetsGeneration,
    assetsReceiptSize: input.assetsReceiptSize,
    assetsReceiptSha256: input.assetsReceiptSha256,
    assetsArgument: input.assetsArgument,
    binding: { executableSha256: new Uint8Array(32).fill(2) },
  };
  expect(
    Buffer.from(nativeLeaseLaunchFingerprint(value.stateDir, launchOnly)).toString("hex"),
  ).toBe(value.sha256);
  expect(
    Buffer.from(
      nativeLeaseLaunchFingerprint(value.stateDir, { ...input, args: input.args.slice(1) }),
    ).toString("hex"),
  ).not.toBe(digest());
});
