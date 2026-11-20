import * as fs from "node:fs/promises";
import { join } from "node:path";
import { MOBILE_GATEWAY_RUNTIME_NAMESPACE } from "../remote-backend/mobileGatewayAssets.receipt.reference.ts";
import { removeMobileRuntimeInventory } from "../remote-backend/mobileGatewayProcess.assets.inventory.ts";
import {
  mobileRuntimeInventoryKey as key,
  mobileRuntimeInventoryStamp as stamp,
} from "../remote-backend/mobileGatewayProcess.assets.walk.ts";
import {
  ASSETS_COMPONENT_FILE,
  GATEWAY_COMPONENT_FILE,
  MOBILE_COMPONENT_NAMESPACE,
  assertPublicationDirectories,
  fileIdentity,
  mobilePublicationDirectoryKey,
  syncDirectory,
} from "./mobileOptionalPublication.files.ts";
import {
  planMobileStageRetirement,
  retireMobileRegistryStages,
  type MobileStageRetirementReason,
} from "./mobileStageRetirement.rules.ts";
import {
  mobileRegistryOwnerEqual,
  type MobileRegistry,
  type MobileRegistryOwner,
} from "./remoteAgentInstall.mobile.schema.ts";
import type { RemoteAgentRegistry } from "./remoteAgentInstall.registry.ts";
import type { MobilePublicationAuthority } from "./mobileOptionalPublication.authority.ts";

/** Held authority: the canonical CAS journal, the publication root and the backend state dir. */
export interface MobileStageRetirementJournal {
  readonly root: string;
  readonly stateDir: string;
  readonly pin: MobileRegistryOwner;
  readonly store: {
    readonly read: () => Promise<RemoteAgentRegistry>;
    readonly update: (
      transition: (state: RemoteAgentRegistry) => RemoteAgentRegistry,
    ) => Promise<RemoteAgentRegistry>;
  };
  readonly assertAuthority: () => Promise<void>;
}
/** The publisher's own authority: retirement runs only while it holds the publication lease. */
export const mobileStageRetirementJournal = (
  authority: MobilePublicationAuthority,
  signal: AbortSignal,
): MobileStageRetirementJournal => ({
  root: authority.root,
  stateDir: authority.owner.stateDir,
  pin: authority.pin,
  store: authority.registry(signal),
  assertAuthority: authority.assertAuthority,
});
export interface MobileStageRetirementEntry {
  readonly stageId: string;
  readonly outcome: "retired" | "kept";
  readonly reason: MobileStageRetirementReason;
}
export interface MobileStageRetirementReport {
  readonly retired: number;
  readonly kept: number;
  /** Stages still in the journal after this run (bounded by `MAX_MOBILE_REGISTRY_STAGES`). */
  readonly live: number;
  readonly entries: ReadonlyArray<MobileStageRetirementEntry>;
}
type Stage = MobileRegistry["stages"][number];
class Kept extends Error {
  readonly reason: MobileStageRetirementReason;
  constructor(reason: MobileStageRetirementReason) {
    super(reason);
    this.reason = reason;
  }
}
const keep = (reason: MobileStageRetirementReason): never => {
  throw new Kept(reason);
};
const lstat = (path: string) =>
  fs.lstat(path, { bigint: true }).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === "ENOENT") return null;
    throw cause;
  });

/**
 * Verified removal plan for a stage's published files, or `null` when nothing is on disk (never
 * created, or removed by an interrupted earlier run). The directory must be the journal's exact
 * owner-keyed, dev/inode-anchored one and hold only the two component files (each private,
 * single-link, and identical to the publication receipt when one was recorded). Removal reuses
 * the runtime GC's stamp-revalidated, non-recursive inventory removal: a late or foreign member
 * makes it fail and is preserved.
 */
async function publishedFilesRemoval(
  journal: MobileStageRetirementJournal,
  stage: Stage,
): Promise<(() => Promise<void>) | null> {
  const intent = stage.publicationIntent;
  if (!intent) return null;
  if (intent.key !== mobilePublicationDirectoryKey(journal.pin, stage))
    return keep("publication-unverified");
  const namespace = join(journal.root, MOBILE_COMPONENT_NAMESPACE);
  const directory = join(namespace, intent.key);
  if (!(await lstat(directory))) return null;
  await assertPublicationDirectories(journal.root, intent).catch(() =>
    keep("publication-unverified"),
  );
  const info = (await lstat(directory)) ?? keep("journal-changed");
  const inventory = new Map([[key(""), stamp(info)]]);
  const receipt = stage.publicationReceipt;
  const uid = BigInt(process.getuid?.() ?? -1);
  for await (const entry of await fs.opendir(directory)) {
    const member =
      entry.name === GATEWAY_COMPONENT_FILE
        ? { mode: 0o700n, identity: receipt?.gateway }
        : entry.name === ASSETS_COMPONENT_FILE
          ? { mode: 0o600n, identity: receipt?.assets }
          : keep("publication-foreign");
    const file = (await lstat(join(directory, entry.name))) ?? keep("journal-changed");
    if (
      !file.isFile() ||
      file.uid !== uid ||
      file.nlink !== 1n ||
      (file.mode & 0o7777n) !== member.mode ||
      (member.identity && JSON.stringify(fileIdentity(file)) !== JSON.stringify(member.identity))
    )
      keep("publication-unverified");
    inventory.set(key(entry.name), stamp(file));
  }
  return async () => {
    await journal.assertAuthority();
    await removeMobileRuntimeInventory(directory, inventory).catch(() => keep("removal-failed"));
    await syncDirectory(namespace);
  };
}

/**
 * Files of a planned stage. A settled original's runtime tree belongs to the orphan GC, whose
 * proof needs the journal row, so the row stays until the GC removed tree and receipt.
 */
async function clearance(
  journal: MobileStageRetirementJournal,
  mobile: MobileRegistry,
  stage: Stage,
) {
  const runtime = join(journal.stateDir, MOBILE_GATEWAY_RUNTIME_NAMESPACE);
  for (const attempt of mobile.gatewayLifecycle?.attempts ?? []) {
    const generation = attempt.nativeOwnership?.assetsReference.generation;
    if (attempt.stageId !== stage.id || !generation) continue;
    const tree = join(runtime, generation);
    if ((await lstat(tree)) || (await lstat(`${tree}.receipt.json`)))
      keep("runtime-assets-present");
  }
  return publishedFilesRemoval(journal, stage);
}

/**
 * Retire every provably unused stage (`planMobileStageRetirement`) so consent cycles never run
 * out: check each planned stage's files first, re-plan with only the cleared stages, remove their
 * published files, then one CAS retires the journal rows. Crash-safe and idempotent: a stage is
 * retirable forever once planned (nothing can name a superseded revision again), files go before
 * rows, and absent files count as removed. Anything uncertain is kept with a fixed reason.
 */
export async function retireSettledMobileStages(
  journal: MobileStageRetirementJournal,
  signal: AbortSignal,
): Promise<MobileStageRetirementReport> {
  await journal.assertAuthority();
  const before = await journal.store.read();
  if (before.schemaVersion !== 3 || !mobileRegistryOwnerEqual(before.mobile.owner, journal.pin))
    throw Error("Mobile stage retirement requires the held authority's journal.");
  const entries: MobileStageRetirementEntry[] = [];
  const kept = (stageId: string, reason: MobileStageRetirementReason) =>
    entries.push({ stageId, outcome: "kept", reason });
  const planned = planMobileStageRetirement(before.mobile, before.pins);
  for (const [stageId, reason] of planned.kept) kept(stageId, reason);
  const removals = new Map<string, (() => Promise<void>) | null>();
  for (const stage of planned.retire) {
    signal.throwIfAborted();
    await clearance(journal, before.mobile, stage).then(
      (removal) => removals.set(stage.id, removal),
      (cause: unknown) => kept(stage.id, cause instanceof Kept ? cause.reason : "removal-failed"),
    );
  }
  const final = planMobileStageRetirement(before.mobile, before.pins, new Set(removals.keys()));
  for (const [stageId, reason] of final.kept) if (removals.has(stageId)) kept(stageId, reason);
  const allowed = new Set<string>();
  for (const stage of final.retire) {
    signal.throwIfAborted();
    await Promise.resolve()
      .then(() => removals.get(stage.id)?.())
      .then(
        () => allowed.add(stage.id),
        (cause: unknown) => kept(stage.id, cause instanceof Kept ? cause.reason : "removal-failed"),
      );
  }
  let after: RemoteAgentRegistry = before;
  if (allowed.size) {
    signal.throwIfAborted();
    await journal.assertAuthority();
    after = await journal.store
      .update((state) => retireMobileRegistryStages(state, journal.pin, allowed))
      .catch(() => journal.store.read());
  }
  const live = after.schemaVersion === 3 ? after.mobile.stages : [];
  for (const stageId of allowed)
    if (live.some((s) => s.id === stageId)) kept(stageId, "journal-changed");
    else entries.push({ stageId, outcome: "retired", reason: "retired" });
  const retired = entries.filter((e) => e.outcome === "retired").length;
  return { retired, kept: entries.length - retired, live: live.length, entries };
}
