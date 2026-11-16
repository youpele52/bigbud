import {
  assertNativeMobileGatewayAssetsCleanup,
  type VerifiedNativeMobileGatewayAssetsCleanup,
} from "./mobileGatewayAssets.nativeCleanup.ts";
import { prepareMobileAssetsReceiptRemoval } from "./mobileGatewayAssets.receipt.files.ts";
import { MOBILE_GATEWAY_RUNTIME_NAMESPACE } from "./mobileGatewayAssets.receipt.reference.ts";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { VerifiedMobilePublication } from "../remote-agent/mobileOptionalPublication.ts";
import {
  withMobilePublicationOwner,
  withMobilePublicationTeardown,
} from "../remote-agent/mobileGatewayLifecycle.publication.ts";
import {
  readComponent,
  privateDirectory,
  directoryIdentity,
} from "../remote-agent/mobileOptionalPublication.files.ts";
import { extractMobileOptionalAssets } from "../remote-agent/mobileOptionalAssets.ts";
import {
  captureMobileRuntimeInventory,
  removeMobileRuntimeInventory,
  verifyMobileRuntimeInventory,
  type MobileRuntimeInventory,
} from "./mobileGatewayProcess.assets.inventory.ts";

const RUNTIME_NAMESPACE = MOBILE_GATEWAY_RUNTIME_NAMESPACE;
declare const assetsBrand: unique symbol;
export interface OwnedMobileGatewayAssets {
  readonly [assetsBrand]: true;
}
interface OwnedAssets {
  readonly stateDir: string;
  readonly parent: string;
  readonly path: string;
  readonly rootIdentity: string;
  readonly parentIdentity: string;
  readonly identity: string;
  readonly inventory: MobileRuntimeInventory;
  readonly controller: string;
  readonly nonce: string;
  readonly stageId: string;
  readonly releaseId: string;
  readonly consentRevision: number;
  launched: boolean;
  transferArmed: boolean;
  removing: boolean;
  receiptWriting: boolean;
}
const owned = new WeakMap<OwnedMobileGatewayAssets, OwnedAssets>();
const identity = async (path: string) =>
  JSON.stringify(directoryIdentity(await privateDirectory(path)));
async function assertParents(record: OwnedAssets) {
  if (
    (await identity(record.stateDir)) !== record.rootIdentity ||
    (await identity(record.parent)) !== record.parentIdentity ||
    (await identity(record.path)) !== record.identity
  )
    throw Error("Owned runtime path was substituted; preserve bytes.");
}
export function markMobileGatewayAssetsLaunched(token: OwnedMobileGatewayAssets): void {
  const record = owned.get(token);
  if (!record) throw Error("Original runtime assets capability required.");
  if (record.receiptWriting) throw Error("Owned receipt publication is still in progress.");
  if (record.transferArmed || record.removing)
    throw Error("Native transfer/cleanup armed; direct Node launch is forbidden.");
  record.launched = true;
}
export function mobileGatewayAssetsPath(token: OwnedMobileGatewayAssets): string {
  const record = owned.get(token);
  if (!record) throw Error("Original runtime assets capability required.");
  return record.path;
}
export function prepareMobileGatewayAssets(
  proof: VerifiedMobilePublication,
  nonce: string,
  external: AbortSignal,
): Promise<OwnedMobileGatewayAssets> {
  return withMobilePublicationOwner(
    proof,
    async (publication, ownedSignal) => {
      const signal = AbortSignal.any([external, ownedSignal]);
      signal.throwIfAborted();
      const { authority, paths } = publication,
        stateDir = authority.owner.stateDir;
      await authority.owner.assertHeld();
      const rootIdentity = await identity(stateDir),
        parent = join(stateDir, RUNTIME_NAMESPACE);
      await privateDirectory(parent, true);
      const parentIdentity = await identity(parent);
      const stream = await fs.opendir(parent);
      let count = 0;
      for await (const _entry of stream)
        if (++count >= 64) throw Error("Preserved runtime generations require admitted repair.");
      const destination = join(parent, `assets-${randomBytes(16).toString("hex")}`);
      const extract = async () => {
        const archive = await readComponent(
          paths.assetsArchivePath,
          paths.assetsArtifact,
          0o600,
          true,
          signal,
        );
        if (!archive.bytes) throw Error("Fresh authenticated archive snapshot unavailable.");
        await publication.revalidate();
        signal.throwIfAborted();
        return extractMobileOptionalAssets({
          mobileConsent: true,
          artifact: paths.assetsArtifact,
          bytes: archive.bytes,
          trustedKeys: publication.trustedKeys,
          host: paths.host,
          release: paths.compatibility,
          destination,
          signal,
        });
      };
      const path = await extract();
      if (!path) throw Error("Fresh runtime extraction did not complete.");
      // Settle the bounded ownership snapshot even if consent just ended; the returned token only permits cleanup.
      const inventory = await captureMobileRuntimeInventory(path, new AbortController().signal);
      const record: OwnedAssets = {
        stateDir,
        parent,
        path,
        rootIdentity,
        parentIdentity,
        identity: await identity(path),
        inventory,
        controller: JSON.stringify(authority.controller),
        nonce,
        stageId: paths.stageId,
        releaseId: paths.releaseId,
        consentRevision: paths.consentRevision,
        launched: false,
        transferArmed: false,
        removing: false,
        receiptWriting: false,
      };
      await assertParents(record);
      await authority.assertAuthority();
      const token = Object.freeze({}) as OwnedMobileGatewayAssets;
      owned.set(token, record);
      return token;
    },
    external,
  );
}
export function verifyMobileGatewayAssets(
  token: OwnedMobileGatewayAssets,
  signal: AbortSignal,
): Promise<void> {
  const record = owned.get(token);
  if (!record) return Promise.reject(Error("Original runtime assets capability required."));
  return assertParents(record).then(() =>
    verifyMobileRuntimeInventory(record.path, record.inventory, signal),
  );
}
/** Never adopts persisted trees; an uncertain child/journal/path leaves this generation intact. */
export function removeMobileGatewayAssets(
  proof: VerifiedMobilePublication,
  token: OwnedMobileGatewayAssets,
  nativeCleanup?: VerifiedNativeMobileGatewayAssetsCleanup,
): Promise<void> {
  const record = owned.get(token);
  if (!record) return Promise.reject(Error("Original runtime assets capability required."));
  if (record.transferArmed && !nativeCleanup)
    return Promise.reject(
      Error(
        "Native transfer may own these bytes; original native exit/cancellation and CAS proof required.",
      ),
    );
  if (record.removing) return Promise.reject(Error("Owned runtime cleanup already in progress."));
  record.removing = true;
  return withMobilePublicationTeardown(proof, async (authority) => {
    if (
      authority.owner.stateDir !== record.stateDir ||
      JSON.stringify(authority.controller) !== record.controller
    )
      throw Error("Original runtime owner required for removal.");
    if (record.transferArmed) {
      if (!nativeCleanup) throw Error("Original native cleanup proof required.");
      await assertNativeMobileGatewayAssetsCleanup(nativeCleanup, token, authority);
    }
    if (record.launched) {
      const state = await authority.registry().read();
      const attempt =
        state.schemaVersion === 3 &&
        state.mobile.gatewayLifecycle?.attempts.find((a) => a.nonce === record.nonce);
      if (
        !attempt ||
        attempt.phase !== "exit-confirmed" ||
        attempt.stageId !== record.stageId ||
        attempt.releaseId !== record.releaseId ||
        attempt.consentRevision !== record.consentRevision ||
        JSON.stringify(attempt.controller) !== record.controller
      )
        throw Error("Runtime child exit is not exactly confirmed; preserve assets.");
    }
    await assertParents(record);
    await verifyMobileRuntimeInventory(record.path, record.inventory);
    const removeReceipt = await prepareMobileAssetsReceiptRemoval(
      token,
      `${record.path}.receipt.json`,
    );
    await authority.assertAuthority();
    await assertParents(record);
    await removeMobileRuntimeInventory(record.path, record.inventory);
    removeReceipt();
    owned.delete(token);
  }).finally(() => {
    record.removing = false;
  });
}

/** Restrictive fence only: never grants native ownership or permits cleanup from a boolean. */
export function armMobileGatewayAssetsTransfer(token: OwnedMobileGatewayAssets): void {
  const record = owned.get(token);
  if (!record) throw Error("Original runtime assets capability required.");
  if (record.receiptWriting) throw Error("Owned receipt publication is still in progress.");
  if (record.launched || record.removing)
    throw Error("Direct child/cleanup assets cannot be transferred to an independent owner.");
  record.transferArmed = true;
}
/** Established before queued IO; only settled original receipt work releases this ordering fence. */
export function beginMobileGatewayAssetsReceiptWrite(token: OwnedMobileGatewayAssets): () => void {
  const record = owned.get(token);
  if (!record) throw Error("Original runtime assets capability required.");
  if (record.removing || record.receiptWriting)
    throw Error("Owned cleanup/receipt publication is already in progress.");
  record.receiptWriting = true;
  return () => {
    record.receiptWriting = false;
  };
}
type AssetPublicationContext = Parameters<Parameters<typeof withMobilePublicationOwner>[1]>[0];
type AssetProjection = Omit<
  Readonly<OwnedAssets>,
  "inventory" | "launched" | "removing" | "receiptWriting"
>;
/** Existing tracked IO/lease only. Projection is data, never raw-path/native approval authority. */
export function withOriginalMobileGatewayAssets<A>(
  proof: VerifiedMobilePublication,
  token: OwnedMobileGatewayAssets,
  operation: (
    data: AssetProjection,
    publication: AssetPublicationContext,
    signal: AbortSignal,
    assertCurrent: () => Promise<void>,
  ) => Promise<A>,
  external?: AbortSignal,
): Promise<A> {
  const record = owned.get(token);
  if (!record) return Promise.reject(Error("Original runtime assets capability required."));
  return withMobilePublicationOwner(
    proof,
    async (publication, ownedSignal) => {
      const signal = external ? AbortSignal.any([external, ownedSignal]) : ownedSignal;
      const assertCurrent = async () => {
        signal.throwIfAborted();
        if (record.removing) throw Error("Owned runtime cleanup already in progress.");
        const { authority, paths } = publication;
        if (
          authority.owner.stateDir !== record.stateDir ||
          JSON.stringify(authority.controller) !== record.controller ||
          paths.stageId !== record.stageId ||
          paths.releaseId !== record.releaseId ||
          paths.consentRevision !== record.consentRevision
        )
          throw Error("Original assets/publication owner tuple changed.");
        await assertParents(record);
        await verifyMobileRuntimeInventory(record.path, record.inventory, signal);
        await publication.revalidate();
        await authority.assertAuthority();
        signal.throwIfAborted();
      };
      await assertCurrent();
      const data = Object.freeze({
        stateDir: record.stateDir,
        parent: record.parent,
        path: record.path,
        rootIdentity: record.rootIdentity,
        parentIdentity: record.parentIdentity,
        identity: record.identity,
        controller: record.controller,
        nonce: record.nonce,
        stageId: record.stageId,
        releaseId: record.releaseId,
        consentRevision: record.consentRevision,
        transferArmed: record.transferArmed,
      });
      const result = await operation(data, publication, signal, assertCurrent);
      await assertCurrent();
      return result;
    },
    external,
  );
}

/** Original-token teardown projection; revocation never upgrades JSON paths into cleanup rights. */
export function withMobileGatewayAssetsTeardown<A>(
  proof: VerifiedMobilePublication,
  token: OwnedMobileGatewayAssets,
  operation: (
    data: Readonly<{
      nonce: string;
      stageId: string;
      releaseId: string;
      consentRevision: number;
      path: string;
    }>,
    authority: Parameters<Parameters<typeof withMobilePublicationTeardown>[1]>[0],
    signal: AbortSignal,
  ) => Promise<A>,
): Promise<A> {
  const record = owned.get(token);
  if (!record || !record.transferArmed || record.removing)
    return Promise.reject(Error("Original armed native assets required for terminal cleanup."));
  return withMobilePublicationTeardown(proof, async (authority, signal) => {
    if (
      record.removing ||
      authority.owner.stateDir !== record.stateDir ||
      JSON.stringify(authority.controller) !== record.controller
    )
      throw Error("Original held runtime owner required for native assets teardown.");
    await authority.assertAuthority();
    await assertParents(record);
    return operation(
      Object.freeze({
        nonce: record.nonce,
        stageId: record.stageId,
        releaseId: record.releaseId,
        consentRevision: record.consentRevision,
        path: record.path,
      }),
      authority,
      signal,
    );
  });
}
