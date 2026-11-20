import { mobileGatewayBuildPin } from "./mobileGatewayLifecycle.transitions.ts";
import {
  mobileRegistryOwnerEqual,
  NO_MOBILE_REGISTRY_RETIREMENT,
  MAX_MOBILE_REGISTRY_STAGES,
  type MobileRegistry,
  type MobileRegistryOwner,
} from "./remoteAgentInstall.mobile.schema.ts";
import {
  parseRemoteAgentRegistry,
  type RemoteAgentRegistry,
} from "./remoteAgentInstall.registry.ts";

/** Fixed reasons; reports name a stage id and one of these, never paths or journal prose. */
export const MOBILE_STAGE_RETIREMENT_REASONS = [
  "retired",
  "current-consent",
  "desired",
  "unsettled-attempt",
  "pinned",
  "history-order",
  "runtime-assets-present",
  "publication-unverified",
  "publication-foreign",
  "removal-failed",
  "journal-changed",
] as const;
export type MobileStageRetirementReason = (typeof MOBILE_STAGE_RETIREMENT_REASONS)[number];
type Stage = MobileRegistry["stages"][number];
type Pins = ReadonlyArray<{ readonly owner: string }>;

/**
 * Typed refusal: every journal stage slot holds a stage that is still live, so a new consent
 * revision cannot publish. Never reuses a fence; the owner retires settled stages by repair.
 */
export class MobileStageBudgetExhausted extends Error {
  readonly _tag = "MobileStageBudgetExhausted";
  override readonly name = "MobileStageBudgetExhausted";
  constructor() {
    super(
      `Mobile stage budget exhausted: all ${MAX_MOBILE_REGISTRY_STAGES} stages are still live. ` +
        "Run `bigbud mobile repair` " +
        "(with --resolve after a reboot) to settle and retire old stages, then activate again.",
    );
  }
}

/**
 * Journal evidence that keeps a stage live, or `null` when it is provably unused:
 * - it belongs to the current consent revision (it may be published, selected or served);
 * - the desired selection names it;
 * - an attempt of its revision is unsettled: no exit recorded and no ended epoch (all terminal
 *   evidence, including `native-epoch-ended`, is `exit-confirmed`), so an original may still run;
 * - a gateway base pin of one of those attempts remains.
 * An old revision's stage is already `cancelled`, so its original can only be revoked, never
 * served; once its originals settled nothing can name it again.
 */
export function mobileStageRetirementBlock(
  mobile: MobileRegistry,
  pins: Pins,
  stage: Stage,
): MobileStageRetirementReason | null {
  if (stage.consentRevision >= mobile.consent.revision) return "current-consent";
  if (mobile.desired?.stageId === stage.id) return "desired";
  const attempts = (mobile.gatewayLifecycle?.attempts ?? []).filter(
    (a) => a.stageId === stage.id || a.consentRevision === stage.consentRevision,
  );
  if (attempts.some((a) => a.phase !== "exit-confirmed")) return "unsettled-attempt";
  if (attempts.some((a) => pins.some((p) => p.owner === mobileGatewayBuildPin(a.nonce))))
    return "pinned";
  return null;
}

/** Leading rows that all name candidate stages; a candidate named after them must wait. */
function holdOutOfOrder(
  rows: ReadonlyArray<{ readonly stageId: string }>,
  candidates: Set<string>,
  kept: Map<string, MobileStageRetirementReason>,
): boolean {
  let prefix = 0;
  while (prefix < rows.length && candidates.has(rows[prefix]!.stageId)) prefix += 1;
  let changed = false;
  for (const row of rows.slice(prefix))
    if (candidates.delete(row.stageId)) {
      kept.set(row.stageId, "history-order");
      changed = true;
    }
  return changed;
}

/**
 * Stages that retire now: journal-unused (see `mobileStageRetirementBlock`), optionally limited
 * to `allowed` (stages whose files the caller cleared), and whose attempts and selections are the
 * oldest rows, so the attempt and history ledgers only ever lose a prefix.
 */
export function planMobileStageRetirement(
  mobile: MobileRegistry,
  pins: Pins,
  allowed?: ReadonlySet<string>,
) {
  const kept = new Map<string, MobileStageRetirementReason>();
  const candidates = new Set<string>();
  for (const stage of mobile.stages) {
    const block = mobileStageRetirementBlock(mobile, pins, stage);
    if (block) kept.set(stage.id, block);
    else if (!allowed || allowed.has(stage.id)) candidates.add(stage.id);
  }
  const attempts = mobile.gatewayLifecycle?.attempts ?? [];
  const history = mobile.desiredHistory ?? [];
  let changed = true;
  while (changed)
    changed =
      holdOutOfOrder(attempts, candidates, kept) || holdOutOfOrder(history, candidates, kept);
  return { retire: mobile.stages.filter((s) => candidates.has(s.id)), kept };
}

/**
 * CAS transition: re-plans on the exact state it writes and retires the allowed, still unused
 * stages with their settled attempts and history rows, plus releases nothing references any more.
 * The tally advances monotonically. Nothing retirable is an identity no-op.
 */
export function retireMobileRegistryStages(
  state: RemoteAgentRegistry,
  owner: MobileRegistryOwner,
  allowed: ReadonlySet<string>,
): RemoteAgentRegistry {
  if (state.schemaVersion !== 3 || !mobileRegistryOwnerEqual(state.mobile.owner, owner))
    throw Error("Mobile stage retirement requires the held authority's journal.");
  const mobile = state.mobile;
  const { retire } = planMobileStageRetirement(mobile, state.pins, allowed);
  if (!retire.length) return state;
  const ids = new Set(retire.map((s) => s.id));
  const lifecycle = mobile.gatewayLifecycle;
  const attempts = (lifecycle?.attempts ?? []).filter((a) => !ids.has(a.stageId));
  const history = (mobile.desiredHistory ?? []).filter((row) => !ids.has(row.stageId));
  const stages = mobile.stages.filter((s) => !ids.has(s.id));
  const referenced = new Set([
    ...stages.map((s) => s.releaseId),
    ...attempts.map((a) => a.releaseId),
    ...history.map((row) => row.releaseId),
    ...(mobile.desired ? [mobile.desired.releaseId] : []),
  ]);
  const tally = mobile.retired ?? NO_MOBILE_REGISTRY_RETIREMENT;
  return parseRemoteAgentRegistry(
    JSON.stringify({
      ...state,
      revision: state.revision + 1,
      mobile: {
        ...mobile,
        releases: mobile.releases.filter((r) => referenced.has(r.id)),
        stages,
        ...(mobile.desiredHistory ? { desiredHistory: history } : {}),
        ...(lifecycle ? { gatewayLifecycle: { ...lifecycle, attempts } } : {}),
        retired: {
          stages: tally.stages + ids.size,
          revisionFloor: Math.max(tally.revisionFloor, ...retire.map((s) => s.consentRevision)),
          selections: tally.selections + (mobile.desiredHistory ?? []).length - history.length,
          attempts: tally.attempts + (lifecycle?.attempts ?? []).length - attempts.length,
        },
      },
    }),
  );
}

/**
 * Transition invariant for any CAS writer: a stage leaves only if it was unused in `before`, the
 * tally counts it, nothing in `next` still names it, and a newly reserved stage is newer than
 * every retired one. Without a retirement the tally is unchanged.
 */
export function assertMobileStageRetirementTransition(
  before: MobileRegistry,
  beforePins: Pins,
  next: MobileRegistry,
): void {
  const removed = before.stages.filter((p) => !next.stages.some((s) => s.id === p.id));
  const prior = before.retired ?? NO_MOBILE_REGISTRY_RETIREMENT;
  const after = next.retired ?? NO_MOBILE_REGISTRY_RETIREMENT;
  const names = new Set([
    ...(next.gatewayLifecycle?.attempts ?? []).map((a) => a.stageId),
    ...(next.desiredHistory ?? []).map((row) => row.stageId),
    ...(next.desired ? [next.desired.stageId] : []),
  ]);
  if (
    (before.retired && !next.retired) ||
    after.stages - prior.stages !== removed.length ||
    after.revisionFloor < prior.revisionFloor ||
    after.selections < prior.selections ||
    after.attempts < prior.attempts ||
    (!removed.length && JSON.stringify(after) !== JSON.stringify(prior)) ||
    removed.some(
      (stage) =>
        mobileStageRetirementBlock(before, beforePins, stage) !== null ||
        stage.consentRevision > after.revisionFloor ||
        names.has(stage.id),
    )
  )
    throw new Error("Mobile journal replay fences cannot be discarded.");
  for (const stage of next.stages)
    if (
      !before.stages.some((p) => p.id === stage.id) &&
      stage.consentRevision <= after.revisionFloor
    )
      throw new Error("A retired mobile stage revision cannot be reserved again.");
}
