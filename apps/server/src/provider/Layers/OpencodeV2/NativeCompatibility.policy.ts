import { v2Request, type OpencodeV2Client } from "./Client.ts";
import {
  validateV2NativeConfigSources,
  projectV2NativeConfigSources,
} from "./NativeCompatibility.sources.ts";
import { inspectV2PluginControls } from "./PluginSetup.policy.ts";
import type { V2ThreadRegistration } from "./Orchestration.registration.ts";
import {
  V2NativeCompatibilityError,
  type V2NativeRuntimeProof,
} from "./NativeCompatibility.types.ts";

type PolicyProof = Pick<
  V2NativeRuntimeProof,
  "assertCurrent" | "assertConfigRead" | "directory" | "root" | "semanticProfile" | "nativeVersion"
>;

/** Fresh source/policy proof is required even for an already loaded/manual bootstrap. Machine
 * documents use native projections only; raw validation is restricted to owned user/project files. */
export async function assertV2NativeRuntimePolicy(
  client: OpencodeV2Client,
  proof: PolicyProof,
  signal?: AbortSignal,
  registration?: V2ThreadRegistration,
) {
  const authority = {
    signal: signal ?? new AbortController().signal,
    assertCurrent: () => proof.assertCurrent(),
  };
  authority.signal.throwIfAborted();
  proof.assertConfigRead();
  proof.assertCurrent();
  const entries = await v2Request(
    "canonical source policy",
    (abort) => client.config.get({ location: { directory: proof.directory } }, { signal: abort }),
    { signal: authority.signal, timeoutMs: 5000 },
  );
  await assertV2NativeSourcePolicy(entries, proof, signal, registration);
}

/** Validate the exact observed projection before eligibility or publication; no raw machine reads. */
export async function assertV2NativeSourcePolicy(
  entries: Awaited<ReturnType<OpencodeV2Client["config"]["get"]>>,
  proof: PolicyProof,
  signal?: AbortSignal,
  registration?: V2ThreadRegistration,
) {
  const authority = {
    signal: signal ?? new AbortController().signal,
    assertCurrent: () => proof.assertCurrent(),
  };
  proof.assertCurrent();
  proof.assertConfigRead();
  authority.signal.throwIfAborted();
  const machinePaths = validateV2NativeConfigSources(entries, proof.root, proof.semanticProfile);
  try {
    await inspectV2PluginControls(
      projectV2NativeConfigSources(entries),
      proof.root,
      authority,
      proof.directory,
      machinePaths,
      registration,
    );
  } catch (error) {
    if (error instanceof V2NativeCompatibilityError) throw error;
    throw new V2NativeCompatibilityError(
      "config-source-unverified",
      "native source policy is denied, ambiguous or not safely owned; canonical authority remains blocked.",
      proof.nativeVersion,
    );
  }
  proof.assertCurrent();
  authority.signal.throwIfAborted();
}
