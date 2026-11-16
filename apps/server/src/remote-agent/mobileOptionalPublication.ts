import {
  mintMobilePublication,
  revalidateMobilePublicationToken,
} from "./mobileGatewayLifecycle.publication.ts";
import {
  createMobilePublicationWork,
  MOBILE_PUBLICATION_IO_RESERVATION,
} from "./mobileOptionalPublication.work.ts";
import { settleOwnedMobilePublisher } from "./mobileOptionalPublication.lifetime.ts";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import {
  parseMobileOptionalArtifact,
  verifyMobileOptionalArtifactBytes,
  verifyMobileOptionalArtifactSignature,
} from "@bigbud/shared/mobileOptionalArtifact";
import { mobileRegistryReleaseId } from "./remoteAgentInstall.mobile.schema.ts";
import {
  reserveRemoteAgentMobileStage,
  verifyRemoteAgentMobileStageBytes,
} from "./remoteAgentInstall.mobile.transitions.ts";
import {
  recordMobilePublicationIntent,
  recordMobilePublicationReceipt,
  requireCurrentMobilePublicationStage,
} from "./mobileOptionalPublication.journal.ts";
import {
  acquireMobilePublicationAuthority,
  assertMobilePublicationAuthority,
  retireMobilePublicationAuthority,
  releaseMobilePublicationAuthority,
  type MobilePublicationAuthority,
} from "./mobileOptionalPublication.authority.ts";
import {
  privateDirectory,
  directoryIdentity,
  syncDirectory,
  assertPublicationDirectories,
  inspectPublishedPair,
  writeComponent,
  MOBILE_COMPONENT_NAMESPACE,
  GATEWAY_COMPONENT_FILE,
  ASSETS_COMPONENT_FILE,
  MobilePublicationRepairRequired,
  mobilePublicationDirectoryKey,
} from "./mobileOptionalPublication.files.ts";
import {
  inspectMobilePublication,
  probeMobilePublicationArchive,
} from "./mobileOptionalPublication.verify.ts";

declare const publicationProof: unique symbol;
export interface VerifiedMobilePublication {
  readonly [publicationProof]: true;
}
export function revalidateMobileOptionalPublication(
  token: VerifiedMobilePublication,
  signal?: AbortSignal,
) {
  return revalidateMobilePublicationToken(token, signal);
}

export interface MobilePublicationRequest {
  readonly stageId: string;
  readonly consentRevision: number;
  readonly gateway: unknown;
  readonly assets: unknown;
  readonly gatewayBytes: Uint8Array;
  readonly assetsBytes: Uint8Array;
}
export interface MobileOptionalPublisher {
  readonly publish: (request: MobilePublicationRequest) => Promise<VerifiedMobilePublication>;
  readonly remint: (stageId: string, consentRevision: number) => Promise<VerifiedMobilePublication>;
}
function createPublisher(
  authority: MobilePublicationAuthority,
  suppliedKeys: Readonly<Record<string, string>>,
  lifetime: AbortSignal,
) {
  const keys = Object.freeze({ ...suppliedKeys });
  const work = createMobilePublicationWork<VerifiedMobilePublication>(authority, keys, lifetime);
  const { start, watch } = work;
  const guard = (signal: AbortSignal) => {
    assertMobilePublicationAuthority(authority);
    signal.throwIfAborted();
  };
  const publish: MobileOptionalPublisher["publish"] = (request) => {
    const stageId = request.stageId,
      consentRevision = request.consentRevision;
    const gateway = parseMobileOptionalArtifact(request.gateway);
    const assets = parseMobileOptionalArtifact(request.assets);
    if (gateway.kind !== "mobile-gateway" || assets.kind !== "mobile-assets")
      return Promise.reject(new Error("Distinct mobile component pair required."));
    for (const artifact of [gateway, assets]) verifyMobileOptionalArtifactSignature(artifact, keys);
    verifyMobileOptionalArtifactBytes(gateway, request.gatewayBytes);
    verifyMobileOptionalArtifactBytes(assets, request.assetsBytes);
    const releaseId = mobileRegistryReleaseId(gateway, assets);
    const operationId = `${releaseId}:${consentRevision}`;
    const size = MOBILE_PUBLICATION_IO_RESERVATION;
    const prior = work.join(stageId, operationId);
    if (prior) return prior;
    work.assertCapacity(size);
    const gatewayBytes = Buffer.from(request.gatewayBytes),
      assetsBytes = Buffer.from(request.assetsBytes);
    verifyMobileOptionalArtifactBytes(gateway, gatewayBytes);
    verifyMobileOptionalArtifactBytes(assets, assetsBytes);
    return start(stageId, operationId, size, async (signal, controller) => {
      const completion = { id: stageId, releaseId, gatewayBytes, assetsBytes };
      let current = await authority.inspect(consentRevision, gateway, keys, signal);
      await current.store.update((state) =>
        reserveRemoteAgentMobileStage(
          state,
          authority.context(state, consentRevision, gateway, keys),
          { id: stageId, gateway, assets },
        ),
      );
      const inspectCurrent = async () => {
        const observed = await authority.inspect(consentRevision, gateway, keys, signal);
        requireCurrentMobilePublicationStage(observed.state, observed.context, stageId);
        return observed;
      };
      current = await inspectCurrent();
      await current.store.update((state) =>
        verifyRemoteAgentMobileStageBytes(
          state,
          authority.context(state, consentRevision, gateway, keys),
          completion,
        ),
      );
      const stopWatch = watch(stageId, consentRevision, gateway, controller);
      try {
        current = await inspectCurrent();
        if (current.state.schemaVersion !== 3) throw new Error("Missing publication journal.");
        let stage = current.state.mobile.stages.find((entry) => entry.id === stageId)!;
        const namespace = join(authority.root, MOBILE_COMPONENT_NAMESPACE);
        await privateDirectory(namespace, true);
        const names = await fs.opendir(namespace);
        let count = 0;
        for await (const _entry of names)
          if (++count > 64) throw new Error("Preserved mobile namespace needs admitted repair.");
        const key = mobilePublicationDirectoryKey(authority.pin, stage);
        let intent = stage.publicationIntent;
        if (!intent) {
          const directory = join(namespace, key);
          guard(signal);
          try {
            await fs.mkdir(directory, { mode: 0o700 });
          } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
            throw new MobilePublicationRepairRequired(
              "Unclaimed mobile component directory requires owner-admitted repair; preserve it.",
              { cause },
            );
          }
          intent = {
            key,
            root: directoryIdentity(await privateDirectory(authority.root)),
            namespace: directoryIdentity(await privateDirectory(namespace)),
            directory: directoryIdentity(await privateDirectory(directory)),
          };
          await syncDirectory(namespace);
          await syncDirectory(authority.root);
          await inspectCurrent();
          const ownedIntent = intent;
          await current.store.update((state) =>
            recordMobilePublicationIntent(
              state,
              authority.context(state, consentRevision, gateway, keys),
              completion,
              ownedIntent,
            ),
          );
        }
        if (intent.key !== key) throw new Error("Mobile publication namespace identity conflict.");
        const directory = await assertPublicationDirectories(authority.root, intent);
        await inspectCurrent();
        const chunkGuard = async () => {
          guard(signal);
          await assertPublicationDirectories(authority.root, intent);
        };
        await writeComponent(
          join(directory, GATEWAY_COMPONENT_FILE),
          gateway,
          gatewayBytes,
          0o700,
          chunkGuard,
          signal,
        );
        await inspectCurrent();
        await writeComponent(
          join(directory, ASSETS_COMPONENT_FILE),
          assets,
          assetsBytes,
          0o600,
          chunkGuard,
          signal,
        );
        await syncDirectory(directory);
        await syncDirectory(namespace);
        current = await inspectCurrent();
        const release =
          current.state.schemaVersion === 3 &&
          current.state.mobile.releases.find((entry) => entry.id === releaseId);
        if (!release) throw new Error("Mobile release disappeared.");
        await probeMobilePublicationArchive(
          authority,
          release,
          current.context,
          key,
          assetsBytes,
          signal,
        );
        const files = await inspectPublishedPair(
          authority.root,
          intent,
          gateway,
          assets,
          false,
          signal,
        );
        await inspectCurrent();
        const ownedIntent = intent;
        await current.store.update((state) =>
          recordMobilePublicationReceipt(
            state,
            authority.context(state, consentRevision, gateway, keys),
            completion,
            ownedIntent,
            files.receipt,
          ),
        );
        const verified = await inspectMobilePublication(
          authority,
          stageId,
          consentRevision,
          keys,
          signal,
        );
        return mintMobilePublication(
          authority,
          stageId,
          consentRevision,
          keys,
          JSON.stringify(verified.stage),
          false,
        );
      } finally {
        await stopWatch();
      }
    });
  };
  const remint: MobileOptionalPublisher["remint"] = (stageId, consentRevision) =>
    start(
      stageId,
      `remint:${consentRevision}`,
      MOBILE_PUBLICATION_IO_RESERVATION,
      async (signal) => {
        const verified = await inspectMobilePublication(
          authority,
          stageId,
          consentRevision,
          keys,
          signal,
          true,
          true,
        );
        if (!verified.files.assetsBytes)
          throw new Error("Verified mobile archive snapshot is missing.");
        await probeMobilePublicationArchive(
          authority,
          verified.release,
          verified.context,
          verified.stage.publicationIntent!.key,
          verified.files.assetsBytes,
          signal,
        );
        const final = await inspectMobilePublication(
          authority,
          stageId,
          consentRevision,
          keys,
          signal,
          true,
        );
        return mintMobilePublication(
          authority,
          stageId,
          consentRevision,
          keys,
          JSON.stringify(final.stage),
          true,
        );
      },
    );
  return { api: Object.freeze({ publish, remint }), close: work.close };
}

/** Service-derived authority and settled cancellation, never caller JSON owner/path authority. */
export function withMobileOptionalPublisher<A>(
  keys: Readonly<Record<string, string>>,
  operation: (publisher: MobileOptionalPublisher, signal: AbortSignal) => Promise<A>,
) {
  return Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const authority = yield* acquireMobilePublicationAuthority;
      return yield* restore(
        settleOwnedMobilePublisher((signal) => createPublisher(authority, keys, signal), operation),
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            retireMobilePublicationAuthority(authority);
            releaseMobilePublicationAuthority(authority);
          }),
        ),
      );
    }),
  );
}
