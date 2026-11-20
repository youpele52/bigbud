import * as fs from "node:fs/promises";
import { join } from "node:path";
import { verify } from "node:crypto";
import { expect, it } from "vitest";
import { loadRemoteBackendIdentity } from "./authority.ts";
import { AUTHORITY_FILENAME } from "./authority.files.ts";
import {
  assertNativeLeaseCapabilityDerivation,
  NATIVE_LEASE_CAPABILITY_DOMAIN,
} from "./authority.nativeLeaseCapability.ts";

it("retains the original private signer when loading the same held identity after restart", async () => {
  const stateDir = await fs.realpath(await fs.mkdtemp("/tmp/bb-native-identity-"));
  const owner = {
    stateDir,
    machineId: "machine-v1:native-identity-fixture",
    nonce: "original-acquisition",
    assertHeld: async () => {},
  };
  try {
    const first = await loadRemoteBackendIdentity(owner);
    const context = Buffer.from("canonical-original-owner-native-binding-and-assets-receipt");
    const derive = first.deriveNativeLeaseCapability;
    assertNativeLeaseCapabilityDerivation(derive, first.authority.keyFingerprint);
    const capability = derive(context);
    const before = await fs.readFile(join(stateDir, AUTHORITY_FILENAME));
    const restarted = await loadRemoteBackendIdentity(
      { ...owner, nonce: "restarted-acquisition" },
      { requireExisting: true },
    );
    const rederive = restarted.deriveNativeLeaseCapability;
    assertNativeLeaseCapabilityDerivation(rederive, restarted.authority.keyFingerprint);
    expect(rederive(context)).toEqual(capability);
    expect(await fs.readFile(join(stateDir, AUTHORITY_FILENAME))).toEqual(before);
    expect(
      verify(
        null,
        Buffer.concat([Buffer.from(NATIVE_LEASE_CAPABILITY_DOMAIN), context]),
        first.publicKey,
        capability,
      ),
    ).toBe(true);
    const publicChallenge = Buffer.concat([Buffer.from(NATIVE_LEASE_CAPABILITY_DOMAIN), context]);
    expect(restarted.signChallenge(publicChallenge)).not.toEqual(Buffer.from(capability));
    const publicJson = JSON.stringify(restarted);
    expect(publicJson).not.toContain("deriveNativeLeaseCapability");
    expect(publicJson).not.toContain(Buffer.from(capability).toString("base64"));
    expect(publicJson).not.toContain("PRIVATE KEY");
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});
