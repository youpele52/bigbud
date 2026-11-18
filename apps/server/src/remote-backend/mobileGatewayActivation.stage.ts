import type { MobileRegistry } from "../remote-agent/remoteAgentInstall.mobile.schema.ts";

const MAX_STAGE_ID = 128;

/**
 * The stage this consent revision publishes for the owner's inputs stage id. A consent change
 * cancels every stage and a cancelled stage is a permanent replay fence, so after revoke → grant
 * the inputs' id names a fenced stage forever. The first grant keeps the inputs' id (existing
 * journals stay valid); any later revision derives `<id>.r<revision>`, which no earlier attempt can
 * reference, so an old original still matches only its own (older) revision and can only be
 * revoked. Deterministic from the journal: a remint after restart finds the same stage.
 *
 * Bound: the journal keeps at most `MAX_MOBILE_REGISTRY_STAGES` stages, so the budget of consent
 * cycles per installation is finite; exhaustion refuses publication, never reuses a fence.
 */
export function mobileStageIdForConsent(
  stages: MobileRegistry["stages"],
  inputsStageId: string,
  consentRevision: number,
): string {
  const base = stages.find((stage) => stage.id === inputsStageId);
  if (!base || base.consentRevision === consentRevision) return inputsStageId;
  const suffix = `.r${consentRevision}`;
  return `${inputsStageId.slice(0, MAX_STAGE_ID - suffix.length)}${suffix}`;
}
