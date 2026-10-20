import { exportV2ThreadArtifact } from "./Orchestration.artifact.ts";
import { V2ThreadRecords } from "./Orchestration.records.ts";
import { V2ThreadReceipts } from "./Orchestration.receipts.ts";
import { V2ThreadBridge } from "./Orchestration.bridge.ts";
import { openV2ThreadTransport } from "./Orchestration.transport.ts";
import { verifyV2ThreadTools } from "./Orchestration.readiness.ts";
import { signV2ThreadCallbackResponse } from "./Orchestration.response.ts";
import { decodeV2ThreadCallback } from "./Orchestration.callback.ts";
import { openV2ThreadEncryptedRequest } from "./Orchestration.crypto.ts";
import { runWithAbortableDeadline } from "../../RequestDeadline.ts";
import { V2ThreadImplementationRegistry } from "./Orchestration.implementation.ts";
import { V2ImplementationSelection } from "./Orchestration.implementation.selection.ts";
import { readV2RetainedArtifact } from "./Orchestration.artifact.retained.ts";
import { assertV2SessionBootstrap } from "./Orchestration.selection.ts";
import {
  verifyV2NativeEligibility,
  type V2NativeEligibilityVerifier,
} from "./NativeCompatibility.runtime.ts";
import { prepareV2DeadBackendRecovery } from "./Orchestration.enrollment.deadBackend.ts";
import type { V2BackendInstance } from "./Orchestration.instances.ts";

/** Emitted assets are app-owned; the required preflight decides explicitly authorized setup, never reload. */
export async function makeV2ApplicationOrchestration(
  stateDir: string,
  setup: (
    artifact: Parameters<typeof verifyV2ThreadTools>[0],
    client: Parameters<typeof verifyV2ThreadTools>[1],
    directory: string,
    signal?: AbortSignal,
  ) => Promise<unknown>,
  eligibility: V2NativeEligibilityVerifier = verifyV2NativeEligibility,
  configRoot?: string,
  backend?: V2BackendInstance,
) {
  const artifact = await exportV2ThreadArtifact(stateDir);
  const implementations = new V2ThreadImplementationRegistry();
  const implementationSelection = await V2ImplementationSelection.open(artifact, implementations);
  const records = await V2ThreadRecords.open(
    artifact.root,
    "enrollments",
    artifact.privateKey,
    artifact.publicKey,
  );
  // Before the bridge exists: no receipt reserved by this instance can enter its fence.
  const recovery = await prepareV2DeadBackendRecovery({
    stateDir,
    instance: backend,
    records,
    privateKey: artifact.privateKey,
  });
  const receipts = new V2ThreadReceipts(
    await V2ThreadRecords.open(artifact.root, "receipts", artifact.privateKey, artifact.publicKey),
    recovery?.fence,
  );
  let bridge: V2ThreadBridge | undefined;
  const transport = await openV2ThreadTransport(async (body, signal) => {
    if (!bridge) throw new Error("V2 required thread-tools broker unavailable.");
    const encrypted = openV2ThreadEncryptedRequest(body, artifact.encryptionPrivateKey);
    const input = decodeV2ThreadCallback(encrypted.payload);
    const result = await runWithAbortableDeadline({
      operation: "V2 encrypted callback",
      timeoutMs: input.kind === "invoke" ? 300000 : 5000,
      signal,
      run: (ownedSignal) => bridge!.callback(encrypted.token, input, ownedSignal),
    });
    signal.throwIfAborted();
    return encrypted.seal(
      signV2ThreadCallbackResponse(
        encrypted.payload as typeof input,
        result,
        artifact.privateKey,
        bridge.responseLease(input),
      ),
    );
  });
  bridge = new V2ThreadBridge({
    artifact,
    implementations,
    selectImplementation: () => implementationSelection.refresh(),
    records,
    receipts,
    ...(recovery ? { deadBackend: recovery.context, recordOwner: recovery.recordOwner } : {}),
    callbackUrl: transport.url,
    preflight: async (session) => {
      const installed = session.activation
        ? await readV2RetainedArtifact(artifact, session.activation.stamp.bootstrapDigest)
        : artifact;
      assertV2SessionBootstrap(installed, session.native.id);
      const info = await verifyV2ThreadTools(
        installed,
        session.lease.process.client,
        session.native.location.directory,
        undefined,
        implementationSelection ? await implementationSelection.refresh() : undefined,
        eligibility,
        session.activation?.stamp.nativeProof?.root ?? configRoot,
      );
      if (session.activation && info.setupInstanceId !== session.activation.stamp.setupInstanceId)
        throw new Error(
          "V2 native setup instance changed during held admission; no native prompt was admitted.",
        );
      return {
        bootstrapDigest: installed.bootstrapDigest,
        bootstrapAbi: installed.bootstrapAbi,
        compatibilityDigest: installed.compatibilityDigest,
        compatibility: installed.compatibility,
        nativeProof: info.nativeProof,
      };
    },
  });
  return {
    bridge,
    artifact,
    implementationSelection,
    records,
    deadBackend: recovery?.context,
    preflight: (
      client: Parameters<typeof verifyV2ThreadTools>[1],
      directory: string,
      signal?: AbortSignal,
    ) => setup(artifact, client, directory, signal).then(() => {}),
    async close() {
      bridge!.close();
      await transport.close();
    },
  };
}
