import { verifyV2SyntheticSource } from "./ServerManager.synthetic.source.mjs";
import type { V2IsolatedProcessConfig } from "./ServerManager.types.ts";

export interface V2SyntheticLauncherGrant {
  readonly synthetic: unique symbol;
}
const grants = new WeakMap<V2SyntheticLauncherGrant, { binary: string; profile: string }>();

/** Only exact immutable known Node-fixture bytes can mint this test grant; no arbitrary script,
 * caller-supplied hash, environment assertion or native wrapper qualifies. */
export async function grantV2SyntheticNodeFixture(binary: string, profile: string) {
  await verifyV2SyntheticSource(binary, profile);
  const grant = Object.freeze({}) as V2SyntheticLauncherGrant;
  grants.set(grant, { binary, profile });
  return grant;
}

/** Revalidate before each spawn; a runtime config cannot manufacture a grant or swap its image. */
export async function verifyV2SyntheticNodeFixture(
  grant: V2SyntheticLauncherGrant,
  config: V2IsolatedProcessConfig,
) {
  const bound = grants.get(grant);
  if (
    !bound ||
    config.runtimeTargetId !== "local" ||
    config.binaryPath !== bound.binary ||
    config.profileRoot !== bound.profile
  )
    throw new Error("V2 synthetic launcher grant scope changed.");
  return verifyV2SyntheticSource(bound.binary, bound.profile);
}
