import * as fs from "node:fs/promises";
import { join } from "node:path";
import type { MobileRegistryOwner } from "../remote-agent/remoteAgentInstall.mobile.schema.ts";
import type { RemoteAgentRegistry } from "../remote-agent/remoteAgentInstall.registry.ts";
import { privateDirectory } from "../remote-agent/mobileOptionalPublication.files.ts";
import {
  mobileRuntimeAnchorMatches,
  mobileRuntimeOrphanProof,
  mobileRuntimeReceiptOwnership,
  type MobileRuntimeOrphanProof,
} from "./mobileGatewayAssets.orphan.proof.ts";
import type { MobileRuntimeRepairReason } from "./mobileGatewayAssets.orphan.reasons.ts";
import { mobileAssetsReceiptPathDigest } from "./mobileGatewayAssets.receipt.format.ts";
import {
  readMobileAssetsReceiptFile,
  unlinkVerifiedMobileAssetsReceipt,
} from "./mobileGatewayAssets.receipt.files.ts";
import { MOBILE_GATEWAY_RUNTIME_NAMESPACE } from "./mobileGatewayAssets.receipt.reference.ts";
import { mobileAssetsEntryStat } from "./mobileGatewayAssets.receipt.ts";
import type { MobileAssetsReceipt } from "./mobileGatewayAssets.receipt.schema.ts";
import { removeMobileRuntimeInventory } from "./mobileGatewayProcess.assets.inventory.ts";
import { mobileGatewayAssetsPathHeld } from "./mobileGatewayProcess.assets.ts";
import {
  mobileRuntimeInventoryKey,
  walkMobileRuntimeInventory,
} from "./mobileGatewayProcess.assets.walk.ts";

/** Held authority over the canonical journal and the runtime namespace's state directory. */
export interface MobileRuntimeRepairJournal {
  readonly stateDir: string;
  readonly pin: MobileRegistryOwner;
  readonly read: (signal: AbortSignal) => Promise<RemoteAgentRegistry>;
  readonly assertAuthority: (signal: AbortSignal) => Promise<void>;
}
export interface MobileRuntimeRepairEntry {
  readonly generation: string;
  readonly outcome: "removed" | "kept";
  readonly reason: MobileRuntimeRepairReason;
}
export interface MobileRuntimeRepairReport {
  readonly removed: number;
  readonly kept: number;
  readonly entries: readonly MobileRuntimeRepairEntry[];
}
/** Above the preparation cap (64), so every admitted generation is classified. */
export const MOBILE_RUNTIME_REPAIR_MAX_ENTRIES = 128;
const GENERATION = /^(assets-[a-f0-9]{32})(\.receipt\.json)?$/;

class Kept extends Error {
  readonly reason: MobileRuntimeRepairReason;
  constructor(reason: MobileRuntimeRepairReason) {
    super(reason);
    this.reason = reason;
  }
}
const keep = (reason: MobileRuntimeRepairReason): never => {
  throw new Kept(reason);
};
const lstat = (path: string) =>
  fs.lstat(path, { bigint: true }).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === "ENOENT") return null;
    throw cause;
  });

/** Exact receipt membership; the removal inventory is the walk the receipt was proven against. */
async function provenInventory(root: string, receipt: MobileAssetsReceipt, signal: AbortSignal) {
  const expected = new Map(receipt.entries.map((e) => [e.pathDigest, e]));
  const inventory = new Map<string, string>();
  await walkMobileRuntimeInventory(
    root,
    (entry) => {
      const kind = entry.directory ? "directory" : "file";
      const recorded = expected.get(mobileAssetsReceiptPathDigest(entry.relative, kind));
      if (
        !recorded ||
        recorded.kind !== kind ||
        JSON.stringify(recorded.stat) !== JSON.stringify(mobileAssetsEntryStat(entry.stats))
      )
        throw Error("Runtime member differs from its receipt.");
      inventory.set(mobileRuntimeInventoryKey(entry.relative), entry.fingerprint);
    },
    signal,
  );
  if (inventory.size !== expected.size) throw Error("Runtime members differ from the receipt.");
  return inventory;
}

async function repairGeneration(
  journal: MobileRuntimeRepairJournal,
  namespace: string,
  generation: string,
  signal: AbortSignal,
): Promise<MobileRuntimeRepairReason> {
  const root = join(namespace, generation),
    receiptPath = `${root}.receipt.json`;
  const prove = async (): Promise<Extract<MobileRuntimeOrphanProof, { kind: "proven" }>> => {
    if (mobileGatewayAssetsPathHeld(root)) keep("in-use");
    const proof = mobileRuntimeOrphanProof(await journal.read(signal), journal.pin, generation);
    return proof.kind === "proven" ? proof : keep(proof.reason);
  };
  const { attempt, reference } = await prove();
  const tree = await lstat(root);
  if (tree && !tree.isDirectory()) keep("not-a-directory");
  const file = await readMobileAssetsReceiptFile(receiptPath, reference, undefined, signal).catch(
    (cause: NodeJS.ErrnoException) =>
      keep(cause.code === "ENOENT" ? "receipt-missing" : "receipt-mismatch"),
  );
  const owned = mobileRuntimeReceiptOwnership(file.bytes, generation, attempt, journal.pin);
  if ("reason" in owned) return keep(owned.reason);
  const { anchors } = owned.receipt;
  const [state, parent] = await Promise.all([lstat(journal.stateDir), lstat(namespace)]);
  if (
    !state ||
    !parent ||
    !mobileRuntimeAnchorMatches(state, anchors.state) ||
    !mobileRuntimeAnchorMatches(parent, anchors.namespace) ||
    (tree && !mobileRuntimeAnchorMatches(tree, anchors.root))
  )
    keep("identity-mismatch");
  const inventory = tree
    ? await provenInventory(root, owned.receipt, signal).catch(() => keep("tree-changed"))
    : undefined;
  // Fresh journal and authority immediately before deletion: a racing owner wins.
  await prove();
  await journal.assertAuthority(signal);
  signal.throwIfAborted();
  try {
    if (inventory) await removeMobileRuntimeInventory(root, inventory);
    unlinkVerifiedMobileAssetsReceipt(receiptPath, file.fingerprint);
  } catch {
    keep("removal-failed");
  }
  return inventory ? "proven-orphan" : "receipt-only";
}

/**
 * Conservative orphan runtime-asset GC. A generation (tree and/or its receipt) is removed only
 * with a canonical journal proof (see `mobileRuntimeOrphanProof`), a hash-exact receipt naming the
 * same attempt and owner, matching state/namespace/root dev+inode+owner anchors and an exact tree
 * inventory. Links are never followed; removal uses the normal cleanup's verified inventory
 * removal. Anything uncertain is kept and reported with a fixed reason.
 */
export async function repairMobileRuntimeAssets(
  journal: MobileRuntimeRepairJournal,
  signal: AbortSignal,
): Promise<MobileRuntimeRepairReport> {
  const entries: MobileRuntimeRepairEntry[] = [];
  const report = (): MobileRuntimeRepairReport => ({
    removed: entries.filter((e) => e.outcome === "removed").length,
    kept: entries.filter((e) => e.outcome === "kept").length,
    entries,
  });
  await journal.assertAuthority(signal);
  const namespace = join(journal.stateDir, MOBILE_GATEWAY_RUNTIME_NAMESPACE);
  if (!(await lstat(namespace))) return report();
  await privateDirectory(journal.stateDir);
  await privateDirectory(namespace);
  const names: string[] = [];
  for await (const entry of await fs.opendir(namespace)) {
    if (names.length >= MOBILE_RUNTIME_REPAIR_MAX_ENTRIES * 2) {
      entries.push({ generation: "unknown", outcome: "kept", reason: "budget-exceeded" });
      break;
    }
    names.push(entry.name);
  }
  const generations = new Set<string>();
  for (const name of names.toSorted()) {
    const match = GENERATION.exec(name);
    if (!match) entries.push({ generation: "unknown", outcome: "kept", reason: "unknown-entry" });
    else generations.add(match[1]!);
  }
  for (const generation of generations) {
    signal.throwIfAborted();
    if (entries.length >= MOBILE_RUNTIME_REPAIR_MAX_ENTRIES) {
      entries.push({ generation, outcome: "kept", reason: "budget-exceeded" });
      continue;
    }
    try {
      const reason = await repairGeneration(journal, namespace, generation, signal);
      entries.push({ generation, outcome: "removed", reason });
    } catch (cause) {
      signal.throwIfAborted();
      // Unexpected IO/journal failures are uncertainty, never permission to delete.
      const reason = cause instanceof Kept ? cause.reason : "uncertain";
      entries.push({ generation, outcome: "kept", reason });
    }
  }
  return report();
}
