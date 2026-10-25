import { Schema } from "effect";
import { v2ThreadRegistration } from "./Orchestration.registration.ts";
import type { OpencodeV2Client } from "./Client.ts";
import { callV2ThreadRpc } from "./Client.guard.orchestration.ts";
import { V2_ENROLLMENT_PROTOCOL } from "./Orchestration.protocol.ts";
import { assertV2ImplementationCompatible } from "./Orchestration.compatibility.ts";
import { v2ThreadImplementation } from "./Orchestration.implementation.ts";
import type { V2ThreadImplementation } from "./Orchestration.implementation.types.ts";
import { assertV2NativeThreadSource } from "./Orchestration.readiness.source.ts";
import type { exportV2ThreadArtifact } from "./Orchestration.artifact.ts";
import {
  verifyV2NativeEligibility,
  type V2NativeEligibilityVerifier,
} from "./NativeCompatibility.runtime.ts";
import { V2NativeCompatibilityError } from "./NativeCompatibility.types.ts";
import { resolveV2PluginConfigRoot } from "./PluginSetup.paths.ts";
import { assertV2NativeRuntimePolicy } from "./NativeCompatibility.policy.ts";
import { V2ReadinessError, type V2ReadinessOperation } from "./Orchestration.readiness.failure.ts";

const Info = Schema.Struct({
  protocol: Schema.String,
  issuer: Schema.String,
  artifactDigest: Schema.String,
  bootstrapDigest: Schema.String,
  bootstrapAbi: Schema.String,
  enrollmentProtocol: Schema.Literal(V2_ENROLLMENT_PROTOCOL),
  compatibilityDigest: Schema.String,
  schemaDigest: Schema.String,
  setupInstanceId: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/)),
  nativeVersion: Schema.String,
  tools: Schema.Array(Schema.String),
});

/** Verify private app bytes and the selected Location's loaded ABI before creating/updating native history. */
export async function verifyV2ThreadTools(
  artifact: Awaited<ReturnType<typeof exportV2ThreadArtifact>>,
  client: OpencodeV2Client,
  directory: string,
  signal?: AbortSignal,
  implementation: V2ThreadImplementation = v2ThreadImplementation(),
  eligibility: V2NativeEligibilityVerifier = verifyV2NativeEligibility,
  root: string = resolveV2PluginConfigRoot(),
) {
  let operation: V2ReadinessOperation = "implementation";
  try {
    signal?.throwIfAborted();
    assertV2ImplementationCompatible(implementation, artifact.compatibility);
    operation = "artifact";
    await artifact.verify();
    operation = "native-eligibility";
    const proof = await eligibility(artifact, client, directory, root, signal);
    operation = "native-policy";
    await assertV2NativeRuntimePolicy(client, proof, signal, v2ThreadRegistration(artifact));
    operation = "rpc-info";
    const registration = v2ThreadRegistration(artifact);
    const value = await callV2ThreadRpc(
      client,
      directory,
      "info",
      {},
      undefined,
      undefined,
      signal,
      registration,
    );
    signal?.throwIfAborted();
    proof.assertCurrent();
    operation = "contract";
    const info = Schema.decodeUnknownSync(Info)(value, { onExcessProperty: "error" });
    if (
      info.issuer !== artifact.issuer ||
      info.protocol !== registration.id ||
      info.artifactDigest !== artifact.artifactDigest ||
      info.bootstrapDigest !== artifact.artifactDigest ||
      info.bootstrapAbi !== artifact.compatibility.bootstrapAbi ||
      info.compatibilityDigest !== artifact.compatibilityDigest ||
      info.schemaDigest !== implementation.schemaDigest ||
      info.nativeVersion !== proof.nativeVersion ||
      JSON.stringify(info.tools.toSorted()) !== JSON.stringify(registration.tools.toSorted())
    )
      throw new V2NativeCompatibilityError(
        "bootstrap-contract-incompatible",
        "selected Location bootstrap contract/native version does not match verified eligibility.",
        proof.nativeVersion,
      );
    operation = "source";
    await assertV2NativeThreadSource(artifact, client, directory);
    signal?.throwIfAborted();
    proof.assertCurrent();
    return { ...info, nativeProof: proof };
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof V2NativeCompatibilityError) throw error;
    // Native SDK causes may retain credentials or request contents; keep only the stage.
    throw new V2ReadinessError(operation);
  }
}
