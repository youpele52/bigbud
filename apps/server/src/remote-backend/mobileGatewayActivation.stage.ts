import type { MobileRegistry } from "../remote-agent/remoteAgentInstall.mobile.schema.ts";

const MAX_STAGE_ID = 128;

/**
 * The stage this consent revision publishes for the owner's inputs stage id. A consent change
 * cancels every stage and a cancelled stage is a replay fence, so after revoke → grant the inputs'
 * id names a fenced stage. The first grant keeps the inputs' id (existing journals stay valid);
 * any later revision derives `<id>.r<revision>`, which no earlier attempt can reference, so an old
 * original still matches only its own (older) revision and can only be revoked. Deterministic
 * from the journal: a remint after restart finds the same stage.
 *
 * Once any stage was retired (`mobileStageRetirement`), the inputs' id may have left the journal,
 * so it is only reused while it is still present at this very revision; otherwise the derived id
 * is used. Retired ids are therefore never reissued, and the journal tally additionally requires
 * every new stage to be newer than every retired one. Settled stages retire during publication
 * and `mobile repair`, so consent cycles are unlimited; only `MAX_MOBILE_REGISTRY_STAGES`
 * genuinely live stages refuse publication (`stage-budget-exhausted`).
 */
export function mobileStageIdForConsent(
  mobile: Pick<MobileRegistry, "stages" | "retired">,
  inputsStageId: string,
  consentRevision: number,
): string {
  const base = mobile.stages.find((stage) => stage.id === inputsStageId);
  if (base?.consentRevision === consentRevision) return inputsStageId;
  if (!base && !mobile.retired?.stages) return inputsStageId;
  const suffix = `.r${consentRevision}`;
  return `${inputsStageId.slice(0, MAX_STAGE_ID - suffix.length)}${suffix}`;
}
