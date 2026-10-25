import { createHash, sign } from "node:crypto";
import path from "node:path";
import {
  V2_N2_BOOTSTRAP_COMPATIBILITY,
  V2_N2_COMPATIBILITY_DIGEST,
  V2_N3_BOOTSTRAP_COMPATIBILITY,
  V2_N3_COMPATIBILITY_DIGEST,
} from "./Orchestration.compatibility.legacy.ts";
import { V2_COMPATIBILITY_DIGEST } from "./Orchestration.compatibility.ts";
import {
  ensureV2ThreadPrivateChild,
  readV2ThreadPrivateFile,
  writeV2ThreadPrivateFile,
} from "./Orchestration.storage.ts";
import { readV2RetainedArtifact } from "./Orchestration.artifact.retained.ts";
import type { V2PluginSetupArtifact } from "./PluginSetup.record.ts";

/** Synthetic historical behavior fixture, not a native qualification or a production migration path. */
export async function makeV2LegacyRegistrationFixture(preferred: V2PluginSetupArtifact) {
  return makeRetainedRegistrationFixture(preferred, false);
}

/** Reconstruct the historical scoped renderer bytes; never promote synthetic fixtures to qualification. */
export async function makeV2HexRegistrationFixture(preferred: V2PluginSetupArtifact) {
  return makeRetainedRegistrationFixture(preferred, true);
}

async function makeRetainedRegistrationFixture(
  preferred: V2PluginSetupArtifact,
  scopedHex: boolean,
) {
  const compatibility = scopedHex ? V2_N3_BOOTSTRAP_COMPATIBILITY : V2_N2_BOOTSTRAP_COMPATIBILITY;
  const compatibilityDigest = scopedHex ? V2_N3_COMPATIBILITY_DIGEST : V2_N2_COMPATIBILITY_DIGEST;
  const manifest = JSON.parse(
    await readV2ThreadPrivateFile(path.join(preferred.directory, "manifest.json")),
  );
  const modules: Record<string, string> = {};
  for (const [name] of manifest.hashes as [string, string][]) {
    let source = await readV2ThreadPrivateFile(path.join(preferred.directory, name));
    if (name === "index.mjs" && !scopedHex)
      source = source
        .replaceAll('"bigbud.thread.v2."+issuer', '"bigbud.thread.v1"')
        .replace('.map(spec=>({...spec,name:"bb2_"+issuer.slice(0,32)+"_"+spec.action}))', "");
    if (name === "registry.mjs") {
      source = source
        .replace(/^  const compactPrefix=.*\n/m, "")
        .replace(/^    if\(owner\.nativeSessionId\.startsWith.*\n/m, "")
        .replace(
          /^  function namespaced\(sessionID\).*$/m,
          '  function namespaced(sessionID) { return typeof sessionID==="string" && sessionID.startsWith(sessionPrefix) && /^[a-f0-9]{64}$/.test(sessionID.slice(sessionPrefix.length)); }',
        );
      if (!scopedHex) source = source.replace(/^    if\(native\.metadata\.bigbud_issuer.*\n/m, "");
    }
    source = source
      .replaceAll("bigbud.thread.bootstrap.v3", compatibility.bootstrapAbi)
      .replaceAll(V2_COMPATIBILITY_DIGEST, compatibilityDigest);
    modules[name] = source;
  }
  const hash = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
  const hashes = Object.entries(modules)
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, source]) => [name, hash(source)]);
  const digest = hash(JSON.stringify(hashes));
  const { signature: _signature, ...old } = manifest;
  const value = {
    ...old,
    artifactDigest: digest,
    bootstrapDigest: digest,
    compatibility,
    compatibilityDigest,
    hashes,
  };
  const directory = await ensureV2ThreadPrivateChild(path.dirname(preferred.directory), digest);
  for (const [name, source] of Object.entries(modules))
    await writeV2ThreadPrivateFile(path.join(directory, name), source);
  await writeV2ThreadPrivateFile(
    path.join(directory, "manifest.json"),
    JSON.stringify({
      ...value,
      signature: sign(
        null,
        Buffer.from(JSON.stringify(["bigbud.thread.bootstrap.manifest.v1", value])),
        preferred.privateKey,
      ).toString("base64url"),
    }),
  );
  return readV2RetainedArtifact(preferred, digest);
}
