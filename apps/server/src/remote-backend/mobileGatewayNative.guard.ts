import { MAX_REMOTE_AGENT_PINS } from "../remote-agent/remoteAgentInstall.registry.ts";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { BackendInstance } from "../startup/backendInstance.ts";
import { RemoteAgentRuntimeOwners } from "../persistence/Layers/RemoteAgentRuntimeBindings.service.ts";
import type { VerifiedMobilePublication } from "../remote-agent/mobileOptionalPublication.ts";
import { mobileGatewayAdmissionContext } from "../remote-agent/mobileGatewayLifecycle.context.ts";
import {
  MobileGatewayConfiguration,
  validateMobileGatewayConfiguration,
  MAX_MOBILE_GATEWAY_ATTEMPTS,
} from "../remote-agent/mobileGatewayLifecycle.schema.ts";
import { mobileGatewayBuildPin } from "../remote-agent/mobileGatewayLifecycle.transitions.ts";
import { privateDirectory } from "../remote-agent/mobileOptionalPublication.files.ts";
import {
  assertOriginalNativeServiceLeaseClient,
  type NativeServiceLeaseClient,
  type OriginalNativeLeaseAttempt,
} from "../remote-agent/remoteAgentServiceLeaseClient.ts";
import {
  encodeNativeLeaseGuardV2,
  type NativeLeaseGuardPredicate,
  type NativeLeaseGuardAnchor,
  type NativeLeaseGuardValue,
} from "../remote-agent/remoteAgentServiceLease.guard.ts";
import {
  withOriginalMobileGatewayAssets,
  type OwnedMobileGatewayAssets,
} from "./mobileGatewayProcess.assets.ts";
import {
  mobileAssetsReceiptFileState,
  verifyMobileAssetsReceiptFile,
} from "./mobileGatewayAssets.receipt.files.ts";

const literal = (
  path: ReadonlyArray<string>,
  value: NativeLeaseGuardValue,
): NativeLeaseGuardPredicate => ({ path, values: [value] });
async function anchor(path: string): Promise<NativeLeaseGuardAnchor> {
  const info = await privateDirectory(path);
  return {
    path,
    dev: info.dev.toString(),
    ino: info.ino.toString(),
    uid: info.uid.toString(),
    mode: 0o700,
  };
}

/** Original-context guard DATA. Actual factory must acquire its verified managed client first. */
export const makeNativeMobileGatewayGuard = Effect.fn("makeNativeMobileGatewayGuard")(function* (
  proof: VerifiedMobilePublication,
  input: unknown,
) {
  const owner = yield* BackendInstance,
    owners = yield* RemoteAgentRuntimeOwners;
  const configuration = Object.freeze(
    Schema.decodeUnknownSync(MobileGatewayConfiguration)(input, { onExcessProperty: "error" }),
  );
  validateMobileGatewayConfiguration(configuration);
  return async (
    assets: OwnedMobileGatewayAssets,
    client: NativeServiceLeaseClient,
    attempt: OriginalNativeLeaseAttempt,
    external?: AbortSignal,
  ): Promise<Uint8Array> => {
    assertOriginalNativeServiceLeaseClient(client);
    client.assertActivationCapability();
    const nonce = client.attemptNonce(attempt);
    return withOriginalMobileGatewayAssets(
      proof,
      assets,
      async (data, publication, signal, assertCurrent) => {
        if (data.nonce !== nonce || data.transferArmed)
          throw Error(
            "Fresh original nonce/unarmed assets required before native guard preparation.",
          );
        const receipt = mobileAssetsReceiptFileState(assets);
        if (!receipt?.reference) throw Error("Original completed assets receipt required.");
        await verifyMobileAssetsReceiptFile(receipt, `${data.path}.receipt.json`, signal);
        const context = await mobileGatewayAdmissionContext(
          owner,
          owners,
          configuration,
          publication,
          signal,
        );
        const root = publication.authority.root,
          control = join(root, "control-v1");
        const anchors: NativeLeaseGuardAnchor[] = [];
        for (const path of new Set([root, control, owner.stateDir]))
          anchors.push(await anchor(path));
        const pin = context.owner,
          binding = {
            authority: pin.authority.authorityId,
            installation: pin.installationFingerprint,
            nativeEpoch: context.binding.epoch,
            nonce,
            publicationSha256: context.releaseId.slice("mobile-release:".length),
            executableSha256: publication.paths.gatewayArtifact.sha256,
            assetsSha256: publication.paths.assetsArtifact.sha256,
          };
        const selected: NativeLeaseGuardPredicate[] = [
          literal(["stageId"], context.stageId),
          literal(["releaseId"], context.releaseId),
          literal(["consentRevision"], context.consentRevision),
          literal(["phase"], "attempted"),
          literal(["controller", "id"], context.controller.id),
          literal(["controller", "pid"], context.controller.pid),
          literal(["controller", "startedAt"], context.controller.startedAt),
          context.controllerHost.machineId === null
            ? literal(["controllerHost", "hostname"], context.controllerHost.hostname)
            : literal(["controllerHost", "machineId"], context.controllerHost.machineId),
          literal(["configuration", "externalOrigin"], configuration.externalOrigin),
          literal(["configuration", "port"], configuration.port),
          ...Object.entries(binding).map(([key, value]) =>
            literal(["nativeOwnership", "binding", key], value),
          ),
          {
            path: ["nativeOwnership", "binding", "configurationSha256"],
            valueFrom: "configurationSha256",
          },
          { path: ["nativeOwnership", "binding", "guardSha256"], valueFrom: "guardSha256" },
          ...Object.entries(receipt.reference).map(([key, value]) =>
            literal(["nativeOwnership", "assetsReference", key], value),
          ),
          literal(["nativeOwnership", "assetsArgument"], "--assets-dir"),
        ];
        await assertCurrent();
        for (const expected of anchors) {
          signal.throwIfAborted();
          if (JSON.stringify(await anchor(expected.path)) !== JSON.stringify(expected))
            throw Error("Original native guard directory anchor changed.");
        }
        return encodeNativeLeaseGuardV2({
          version: 2,
          file: join(control, "registry.json"),
          anchors,
          all: [
            literal(["schemaVersion"], 3),
            literal(["mobile", "owner", "authority", "authorityId"], pin.authority.authorityId),
            literal(
              ["mobile", "owner", "authority", "keyFingerprint"],
              pin.authority.keyFingerprint,
            ),
            literal(["mobile", "owner", "authority", "keyEpoch"], pin.authority.keyEpoch),
            literal(["mobile", "owner", "installationFingerprint"], pin.installationFingerprint),
            literal(["mobile", "consent", "enabled"], true),
            literal(["mobile", "consent", "revision"], context.consentRevision),
          ],
          select: [
            {
              path: ["mobile", "gatewayLifecycle", "attempts"],
              key: "nonce",
              value: nonce,
              maxRows: MAX_MOBILE_GATEWAY_ATTEMPTS,
              all: selected,
            },
            {
              path: ["pins"],
              key: "owner",
              value: mobileGatewayBuildPin(nonce),
              maxRows: MAX_REMOTE_AGENT_PINS,
              all: [literal(["buildId"], context.binding.buildId)],
            },
          ],
        });
      },
      external,
    );
  };
});
