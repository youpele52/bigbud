import { expect, it } from "vitest";
import { canonicalNativeMobileCapabilityContext } from "./mobileGatewayNative.capability.ts";

const owner = {
  authority: {
    authorityId: "a".repeat(32),
    keyFingerprint: `sha256:${"b".repeat(64)}`,
    keyEpoch: 1,
  },
  installationFingerprint: `sha256:${"c".repeat(64)}`,
};
const original = {
  binding: {
    authority: owner.authority.authorityId,
    installation: owner.installationFingerprint,
    nativeEpoch: "epoch",
    nonce: "original-nonce",
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
    sha256: "7".repeat(64),
  },
  assetsArgument: "--assets-dir",
};

function reordered(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .toReversed()
      .map(([key, nested]) => [key, reordered(nested)]),
  );
}
it("reproduces identical cold-recovery input despite object insertion order and mutable source copies", () => {
  const input = structuredClone({ owner, original });
  const expected = canonicalNativeMobileCapabilityContext(input);
  expect(canonicalNativeMobileCapabilityContext(reordered(input))).toEqual(expected);
  input.original.binding.nonce = "new-operation";
  expect(canonicalNativeMobileCapabilityContext(input)).not.toEqual(expected);
  expect(canonicalNativeMobileCapabilityContext({ owner, original })).toEqual(expected);
  expect(expected.length).toBeLessThanOrEqual(4096);
  expect(JSON.parse(expected.toString("utf8"))).toMatchObject({
    purpose: "bigbud.mobile-native-lease-capability-context.v1",
    assetsArgument: "--assets-dir",
  });
});
it("binds owner key epoch, native epoch and exact prepared receipt without persisting bootstrap secrets", () => {
  const bytes = canonicalNativeMobileCapabilityContext({ owner, original });
  for (const input of [
    { owner: { ...owner, authority: { ...owner.authority, keyEpoch: 2 } }, original },
    {
      owner,
      original: { ...original, binding: { ...original.binding, nativeEpoch: "new-epoch" } },
    },
    {
      owner,
      original: {
        ...original,
        assetsReference: { ...original.assetsReference, sha256: "8".repeat(64) },
      },
    },
  ])
    expect(canonicalNativeMobileCapabilityContext(input)).not.toEqual(bytes);
  expect(() =>
    canonicalNativeMobileCapabilityContext({ owner, original, bootstrap: "secret" }),
  ).toThrow(/Invalid private/);
  expect(() =>
    canonicalNativeMobileCapabilityContext({
      owner,
      original: { ...original, environment: [{ name: "PRIVATE", value: "secret" }] },
    }),
  ).toThrow(/Invalid private/);
});
it("refuses foreign installation/authority and future fields before requesting any signature", () => {
  expect(() =>
    canonicalNativeMobileCapabilityContext({
      owner,
      original: {
        ...original,
        binding: { ...original.binding, installation: `sha256:${"d".repeat(64)}` },
      },
    }),
  ).toThrow(/exact full original owner/);
  expect(() =>
    canonicalNativeMobileCapabilityContext({
      owner,
      original: { ...original, binding: { ...original.binding, authority: "d".repeat(32) } },
    }),
  ).toThrow(/exact full original owner/);
  expect(() =>
    canonicalNativeMobileCapabilityContext({
      owner,
      original: { ...original, assetsReference: { ...original.assetsReference, future: true } },
    }),
  ).toThrow(/Invalid private/);
});
