import * as Schema from "effect/Schema";
import { MobileRegistryOwnerSchema } from "../remote-agent/remoteAgentInstall.mobile.schema.ts";
import { MobileNativeGatewayOwnership } from "../remote-agent/mobileGatewayLifecycle.native.schema.ts";

const Context = Schema.Struct({
  owner: MobileRegistryOwnerSchema,
  original: MobileNativeGatewayOwnership,
});
const PURPOSE = "bigbud.mobile-native-lease-capability-context.v1";

/** Canonical private-signer input DATA only. Never call the public identity challenge signer. */
export function canonicalNativeMobileCapabilityContext(input: unknown): Buffer {
  let context: typeof Context.Type;
  try {
    context = Schema.decodeUnknownSync(Context)(input, { onExcessProperty: "error" });
  } catch {
    throw Error("Invalid private native capability context.");
  }
  const { owner, original } = context,
    { binding, assetsReference } = original;
  if (
    !Number.isSafeInteger(owner.authority.keyEpoch) ||
    binding.authority !== owner.authority.authorityId ||
    binding.installation !== owner.installationFingerprint
  )
    throw Error("Private native capability requires the exact full original owner.");
  const bytes = Buffer.from(
    JSON.stringify({
      purpose: PURPOSE,
      owner: {
        authority: {
          authorityId: owner.authority.authorityId,
          keyFingerprint: owner.authority.keyFingerprint,
          keyEpoch: owner.authority.keyEpoch,
        },
        installationFingerprint: owner.installationFingerprint,
      },
      binding: {
        authority: binding.authority,
        installation: binding.installation,
        nativeEpoch: binding.nativeEpoch,
        nonce: binding.nonce,
        publicationSha256: binding.publicationSha256,
        executableSha256: binding.executableSha256,
        assetsSha256: binding.assetsSha256,
        configurationSha256: binding.configurationSha256,
        guardSha256: binding.guardSha256,
      },
      assetsReference: {
        schemaVersion: 1,
        generation: assetsReference.generation,
        sizeBytes: assetsReference.sizeBytes,
        sha256: assetsReference.sha256,
      },
      assetsArgument: original.assetsArgument,
    }),
    "utf8",
  );
  if (!bytes.length || bytes.length > 4096)
    throw Error("Private native capability context exceeds its bound.");
  return bytes;
}
