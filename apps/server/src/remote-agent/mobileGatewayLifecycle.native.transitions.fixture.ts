/** Published fixture plus one native original ownership for journal-transition tests. */
import { afterEach } from "vitest";
import { publicationFixture } from "./mobileOptionalPublication.test-fixtures.ts";
import { gatewayContext } from "./mobileGatewayLifecycle.test-fixtures.ts";
import type { RemoteAgentRegistry } from "./remoteAgentInstall.registry.ts";
import type { MobileNativeGatewayOwnership } from "./mobileGatewayLifecycle.native.schema.ts";

const fixtures: Awaited<ReturnType<typeof publicationFixture>>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
export async function fixture() {
  const f = await publicationFixture({ ownerStartedAt: "start-v2:linux:fixture-boot:123" });
  fixtures.push(f);
  await f.run((publisher) => publisher.publish(f.request));
  const context = gatewayContext(f),
    state = f.read();
  if (state.schemaVersion !== 3) throw Error("Missing published fixture.");
  const release = state.mobile.releases[0]!;
  const original: MobileNativeGatewayOwnership = {
    binding: {
      authority: context.owner.authority.authorityId,
      installation: context.owner.installationFingerprint,
      nativeEpoch: context.binding.epoch,
      nonce: "native-attempt",
      publicationSha256: context.releaseId.slice(15),
      executableSha256: release.gateway.sha256,
      assetsSha256: release.assets.sha256,
      configurationSha256: "1".repeat(64),
      guardSha256: "2".repeat(64),
    },
    assetsReference: {
      schemaVersion: 1,
      generation: `assets-${"3".repeat(32)}`,
      sizeBytes: 1024,
      sha256: "4".repeat(64),
    },
    assetsArgument: "--assets-dir",
  };
  return { f, context, original };
}
export function row(state: RemoteAgentRegistry) {
  if (state.schemaVersion !== 3 || !state.mobile.gatewayLifecycle)
    throw Error("Missing native lifecycle.");
  return state.mobile.gatewayLifecycle.attempts[0]!;
}
