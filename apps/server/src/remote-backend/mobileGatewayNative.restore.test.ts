import * as fs from "node:fs/promises";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { RemoteAgentFrame } from "../remote-agent/remoteAgentProtocol.ts";
import { connectNativeServiceLeaseClient } from "../remote-agent/remoteAgentServiceLeaseClient.ts";
import { stateDir } from "../remote-agent/remoteAgentServiceLease.test.fixture.ts";
import { successorFixture } from "../remote-agent/remoteAgentServiceLease.successor.fixture.ts";
import { loadRemoteBackendIdentity, type RemoteBackendIdentity } from "./authority.ts";
import { canonicalNativeMobileCapabilityContext } from "./mobileGatewayNative.capability.ts";
import { restoreNativeMobileGatewayLease } from "./mobileGatewayNative.restore.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    readFile: async (...args: Parameters<typeof original.readFile>) => {
      if (args[0] === `/proc/${process.pid}/stat`)
        return `${process.pid} (node) ${["S", ...Array<string>(18).fill("0"), "123"].join(" ")}`;
      if (args[0] === "/proc/sys/kernel/random/boot_id") return "fixture-boot\n";
      return original.readFile(...args);
    },
  };
});

let root = "";
let identity: RemoteBackendIdentity;
let restarted: RemoteBackendIdentity;
const holder = (nonce: string) => ({
  stateDir: root,
  machineId: "machine-v1:native-restore-fixture",
  nonce,
  assertHeld: async () => {},
});
beforeAll(async () => {
  root = await fs.realpath(await fs.mkdtemp("/tmp/bb-native-restore-"));
  identity = await loadRemoteBackendIdentity(holder("original-acquisition"));
  // The successor backend reloads the same held identity after the predecessor died.
  restarted = await loadRemoteBackendIdentity(holder("successor-acquisition"), {
    requireExisting: true,
  });
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const pin = () => ({
  authority: { ...identity.authority },
  installationFingerprint: identity.installationFingerprint,
});
/** The exact journal row a preparation of this fixture identity would have reserved. */
const ownership = (overrides: { nativeEpoch?: string; sha?: string } = {}) => ({
  binding: {
    authority: identity.authority.authorityId,
    installation: identity.installationFingerprint,
    nativeEpoch: overrides.nativeEpoch ?? "epoch",
    nonce: "original-attempt",
    publicationSha256: "1".repeat(64),
    executableSha256: "2".repeat(64),
    assetsSha256: "3".repeat(64),
    configurationSha256: "4".repeat(64),
    guardSha256: "5".repeat(64),
  },
  assetsReference: {
    schemaVersion: 1,
    generation: `assets-${"6".repeat(32)}`,
    sizeBytes: 1234,
    sha256: overrides.sha ?? "7".repeat(64),
  },
  assetsArgument: "--assets-dir",
});
/** Same derivation as `makeNativeMobileGatewayLaunchPreparation` with the publication owner. */
const prepared = (original = ownership()) =>
  Buffer.from(
    identity.deriveNativeLeaseCapability!(
      canonicalNativeMobileCapabilityContext({ owner: pin(), original }),
    ),
  );

/** Actual owner client over scripted replies, recording every frame it sends. */
async function client(epoch = "epoch") {
  const f = successorFixture({}, { epoch });
  const frames: RemoteAgentFrame[] = [];
  const raw = f.connection as unknown as { send: (frame: RemoteAgentFrame) => Promise<void> };
  const send = raw.send;
  raw.send = async (frame) => {
    frames.push(frame);
    return send(frame);
  };
  const value = await connectNativeServiceLeaseClient(f.connection, {
    nativeEpoch: epoch,
    stateDir,
  });
  return { value, frames };
}
const sentReference = (frames: RemoteAgentFrame[]) => {
  const frame = frames.at(-1);
  if (!frame || !("binding" in frame.value) || !("capability" in frame.value))
    throw Error("No native lease frame was sent.");
  return frame.value;
};

it("re-derives the prepared capability and canonical binding bytes after a restart", async () => {
  const c = await client();
  try {
    const pending = restoreNativeMobileGatewayLease(c.value, restarted, pin(), ownership());
    expect(c.value.original(pending)).toEqual(ownership());
    await c.value.resume(pending);
    const sent = sentReference(c.frames);
    expect(Buffer.from(sent.capability)).toEqual(prepared());
    expect(Buffer.from(sent.binding!.guardSha256).toString("hex")).toBe("5".repeat(64));
    expect(Buffer.from(sent.binding!.publicationSha256)).toHaveLength(32);
  } finally {
    await c.value.dispose();
  }
});

it("never matches the prepared capability for a journal row whose receipt bytes changed", async () => {
  const c = await client();
  try {
    const tampered = ownership({ sha: "8".repeat(64) });
    const pending = restoreNativeMobileGatewayLease(c.value, identity, pin(), tampered);
    await c.value.resume(pending);
    expect(Buffer.from(sentReference(c.frames).capability)).not.toEqual(prepared());
    expect(Buffer.from(sentReference(c.frames).capability)).toEqual(prepared(tampered));
  } finally {
    await c.value.dispose();
  }
});

it("refuses non-canonical hex, foreign owners, older epochs and structural clients", async () => {
  const c = await client();
  const older = await client("epoch-2");
  try {
    for (const sha of ["A".repeat(64), "7".repeat(62), `${"7".repeat(63)}g`])
      expect(() =>
        restoreNativeMobileGatewayLease(c.value, identity, pin(), ownership({ sha })),
      ).toThrow(/Invalid journal native ownership/);
    const foreign = { ...pin(), authority: { ...pin().authority, keyEpoch: 2 } };
    expect(() => restoreNativeMobileGatewayLease(c.value, identity, foreign, ownership())).toThrow(
      /held identity/,
    );
    expect(() =>
      restoreNativeMobileGatewayLease(c.value, identity, pin(), { ...ownership(), extra: 1 }),
    ).toThrow(/Invalid journal/);
    // A lease retained under an older Rust epoch needs repair; it is never restored.
    expect(() =>
      restoreNativeMobileGatewayLease(older.value, identity, pin(), ownership()),
    ).toThrow(/Invalid original native lease reference/);
    expect(() =>
      restoreNativeMobileGatewayLease({ ...c.value }, identity, pin(), ownership()),
    ).toThrow(/Original authenticated/);
    const { deriveNativeLeaseCapability: _signer, ...synthetic } = identity;
    expect(() => restoreNativeMobileGatewayLease(c.value, synthetic, pin(), ownership())).toThrow(
      /private native signer/,
    );
    restoreNativeMobileGatewayLease(c.value, identity, pin(), ownership());
    expect(() => restoreNativeMobileGatewayLease(c.value, identity, pin(), ownership())).toThrow(
      /duplicate original nonce/,
    );
    expect(c.frames).toEqual([]);
  } finally {
    await c.value.dispose();
    await older.value.dispose();
  }
});
