import * as fs from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type { MobileGatewayAttempt } from "../remote-agent/mobileGatewayLifecycle.schema.ts";
import type { RemoteAgentRegistry } from "../remote-agent/remoteAgentInstall.registry.ts";
import type { MobileRuntimeRepairJournal } from "./mobileGatewayAssets.orphan.ts";
import { canonicalMobileAssetsReceipt } from "./mobileGatewayAssets.receipt.format.ts";
import { mobileAssetsReceiptPathDigest } from "./mobileGatewayAssets.receipt.format.ts";
import {
  MOBILE_GATEWAY_RUNTIME_NAMESPACE,
  type MobileAssetsReceiptReference,
} from "./mobileGatewayAssets.receipt.reference.ts";
import {
  mobileAssetsDirectoryAnchor,
  mobileAssetsEntryStat,
} from "./mobileGatewayAssets.receipt.ts";
import type { MobileAssetsReceiptEntry } from "./mobileGatewayAssets.receipt.schema.ts";
import { walkMobileRuntimeInventory } from "./mobileGatewayProcess.assets.walk.ts";

export const orphanPin = Object.freeze({
  authority: Object.freeze({
    authorityId: "a".repeat(32),
    keyFingerprint: `sha256:${"b".repeat(64)}`,
    keyEpoch: 1,
  }),
  installationFingerprint: `sha256:${"c".repeat(64)}`,
});
const controller = { id: "controller-1", pid: 4242, startedAt: "start-v2:linux:boot:1" };
const controllerHost = { hostname: "fixture-host", machineId: null };
const releaseId = `mobile-release:${"d".repeat(64)}`;

export interface OrphanTree {
  readonly generation: string;
  readonly root: string;
  readonly receipt: string;
  readonly attempt: MobileGatewayAttempt;
}
type MutableState = {
  schemaVersion: 3;
  pins: { owner: string; buildId: string }[];
  mobile: {
    owner: typeof orphanPin;
    stages: { id: string; phase: string }[];
    gatewayLifecycle: { attempts: MobileGatewayAttempt[] };
  };
};

/** Real private runtime trees and hash-exact receipts under a temporary locked-state stand-in. */
export async function orphanFixture() {
  const stateDir = await fs.realpath(await fs.mkdtemp("/tmp/bb-orphan-"));
  const namespace = join(stateDir, MOBILE_GATEWAY_RUNTIME_NAMESPACE);
  await fs.mkdir(namespace, { mode: 0o700 });
  const state: MutableState = {
    schemaVersion: 3,
    pins: [],
    mobile: {
      owner: orphanPin,
      stages: [{ id: "stage-1", phase: "files-published" }],
      gatewayLifecycle: { attempts: [] },
    },
  };
  let readFailure: Error | undefined;
  const journal: MobileRuntimeRepairJournal = {
    stateDir,
    pin: orphanPin,
    read: async () => {
      if (readFailure) throw readFailure;
      return structuredClone(state) as unknown as RemoteAgentRegistry;
    },
    assertAuthority: async () => {},
  };

  /** Extract-like tree, receipt and its journal attempt (default: exit-confirmed, unpinned). */
  async function tree(
    options: { nonce?: string; stageId?: string; phase?: MobileGatewayAttempt["phase"] } = {},
  ): Promise<OrphanTree> {
    const generation = `assets-${randomBytes(16).toString("hex")}`;
    const root = join(namespace, generation);
    const nonce = options.nonce ?? `nonce-${randomBytes(4).toString("hex")}`;
    const stageId = options.stageId ?? "stage-1";
    await fs.mkdir(join(root, "static"), { recursive: true, mode: 0o700 });
    await fs.writeFile(join(root, "index.html"), "<html></html>", { mode: 0o600 });
    await fs.writeFile(join(root, "static", "app.js"), "void 0;", { mode: 0o600 });
    const entries: MobileAssetsReceiptEntry[] = [];
    let contentBytes = 0;
    await walkMobileRuntimeInventory(root, async (entry) => {
      const stat = mobileAssetsEntryStat(entry.stats);
      const kind = entry.directory ? "directory" : "file";
      const pathDigest = mobileAssetsReceiptPathDigest(entry.relative, kind);
      if (entry.directory) entries.push({ kind: "directory", pathDigest, stat });
      else {
        const bytes = await fs.readFile(entry.path);
        contentBytes += bytes.length;
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        entries.push({ kind: "file", pathDigest, stat, sha256 });
      }
    });
    const anchor = async (path: string) =>
      mobileAssetsDirectoryAnchor(await fs.lstat(path, { bigint: true }));
    const bytes = canonicalMobileAssetsReceipt({
      schemaVersion: 1,
      kind: "mobile-native-assets",
      namespace: MOBILE_GATEWAY_RUNTIME_NAMESPACE,
      generation,
      owner: orphanPin,
      controller,
      controllerHost,
      publication: {
        stageId,
        releaseId,
        consentRevision: 1,
        preparationNonce: nonce,
        archiveSha256: "e".repeat(64),
      },
      anchors: {
        state: await anchor(stateDir),
        namespace: await anchor(namespace),
        root: await anchor(root),
      },
      contentBytes,
      entries,
    });
    const receipt = `${root}.receipt.json`;
    await fs.writeFile(receipt, bytes, { mode: 0o600, flag: "wx" });
    const reference: MobileAssetsReceiptReference = {
      schemaVersion: 1,
      generation,
      sizeBytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    const attempt = {
      nonce,
      stageId,
      releaseId,
      consentRevision: 1,
      controller,
      controllerHost,
      phase: options.phase ?? "exit-confirmed",
      nativeOwnership: { assetsReference: reference, assetsArgument: "--assets-dir" },
    } as unknown as MobileGatewayAttempt;
    state.mobile.gatewayLifecycle.attempts.push(attempt);
    return { generation, root, receipt, attempt };
  }
  const exists = (path: string) =>
    fs.lstat(path).then(
      () => true,
      () => false,
    );
  return {
    stateDir,
    namespace,
    state,
    journal,
    tree,
    exists,
    failReads: (cause: Error | undefined) => {
      readFailure = cause;
    },
    close: () => fs.rm(stateDir, { recursive: true, force: true }),
  };
}
