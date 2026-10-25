import path from "node:path";
import { v2ThreadRegistration } from "./Orchestration.registration.ts";
import { v2Request, type OpencodeV2Client } from "./Client.ts";
import { callV2ThreadRpc } from "./Client.guard.orchestration.ts";
import type { V2PluginSetupArtifact } from "./PluginSetup.record.ts";
import { readV2RetainedArtifact } from "./Orchestration.artifact.retained.ts";
import { verifyV2ThreadTools } from "./Orchestration.readiness.ts";
import {
  verifyV2NativeEligibility,
  verifyV2NativeReadOnlyEligibility,
  type V2NativeEligibilityVerifier,
} from "./NativeCompatibility.runtime.ts";
import { resolveV2PluginConfigRoot } from "./PluginSetup.paths.ts";

/** A unique app-private manual source may retain a signed compatible N artifact; L is remediation-only. */
export async function readV2CompatibleManualBootstrap(
  preferred: V2PluginSetupArtifact,
  client: OpencodeV2Client,
  directory: string,
  signal?: AbortSignal,
  eligibility: V2NativeEligibilityVerifier = verifyV2NativeEligibility,
  root: string = resolveV2PluginConfigRoot(),
) {
  await verifyV2NativeReadOnlyEligibility(preferred, client, directory, root, signal, eligibility);
  const inventory = await v2Request(
    "retained manual bootstrap source",
    (abort) => client.plugin.list({ location: { directory } }, { signal: abort }),
    { ...(signal ? { signal } : {}), timeoutMs: 5000 },
  );
  const registration = v2ThreadRegistration(preferred);
  const matches = inventory.data.filter((plugin) => plugin.id === registration.id);
  if (inventory.data.length > 1000 || matches.length > 1)
    throw new Error("V2 required manual bootstrap namespace is colliding.");
  const plugin = matches[0];
  if (!plugin || plugin.source.type !== "local") return undefined;
  let source = plugin.source.path;
  if (["index.mjs", "server.js"].includes(path.basename(source))) source = path.dirname(source);
  if (
    path.dirname(source) !== path.dirname(preferred.directory) ||
    !/^[a-f0-9]{64}$/.test(path.basename(source))
  )
    return undefined;
  let info: Record<string, unknown>;
  try {
    info = (await callV2ThreadRpc(
      client,
      directory,
      "info",
      {},
      undefined,
      undefined,
      signal,
      registration,
    )) as Record<string, unknown>;
  } catch {
    throw new Error(
      "V2 required bigbud thread-tools setup is incomplete for the existing manual entry; no create/update/prompt was admitted. Native models/history remain available independently; no autoload alias or native reload was attempted.",
    );
  }
  signal?.throwIfAborted();
  if (info.protocol === "bigbud.thread.v1" && info.enrollmentProtocol === undefined)
    throw new Error(
      "V2 legacy-manual-bootstrap-update-required: this manual L entry is cleanup-only for the new app. Update that entry explicitly; native config/history was not rewritten and no autoload alias was added.",
    );
  const artifact = await readV2RetainedArtifact(preferred, path.basename(source));
  if (v2ThreadRegistration(artifact).id !== registration.id)
    throw new Error("V2 retained registration family mismatch; no cross-family adoption.");
  if (artifact.bootstrapAbi !== preferred.bootstrapAbi)
    throw new Error(
      "V2 manual bootstrap namespace ABI requires an explicit update; no compact-session downgrade, autoload alias or history mutation.",
    );
  await verifyV2ThreadTools(artifact, client, directory, signal, undefined, eligibility, root);
  return artifact;
}
