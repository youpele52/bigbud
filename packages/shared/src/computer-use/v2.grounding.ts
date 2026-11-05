/**
 * Dormant cross-field validation for decoded desktop v2 actions (plan M3
 * "Freeze the public v2 wire contract"). Schema decoding already rejects raw
 * PID/window selectors, unknown fields and numeric coercion; this adds the
 * rules a struct schema cannot express. Owner-side checks (reference
 * identity, frame bounds, policy, pause) still run later; passing here is not
 * admission. Nothing calls this while legacy Driver 0.9.1 stays selected.
 */
import type {
  ComputerUseDelivery,
  ComputerUseDesktopV2Action,
  ComputerUseV2ErrorCode,
} from "@bigbud/contracts/orchestration/computerUseDesktopV2";

import { normalizeScroll, type NormalizedScroll } from "./scroll";

export interface GroundedDesktopV2Action {
  readonly action: ComputerUseDesktopV2Action;
  /** Resolved delivery for input/launch/navigate; absent for reads. */
  readonly delivery?: ComputerUseDelivery;
  readonly scroll?: NormalizedScroll;
}

export type DesktopV2Grounding =
  | { readonly ok: true; readonly value: GroundedDesktopV2Action }
  | { readonly ok: false; readonly code: ComputerUseV2ErrorCode; readonly field: string };

const refuse = (code: ComputerUseV2ErrorCode, field: string): DesktopV2Grounding => ({
  ok: false,
  code,
  field,
});

type DeliveryFields = {
  readonly delivery?: ComputerUseDelivery | undefined;
  readonly background?: boolean | undefined;
};

/**
 * Explicit request first, then the user default. `background` is an
 * equivalent compatibility spelling; disagreeing spellings refuse.
 */
export function resolveDelivery(
  fields: DeliveryFields,
  userDefault: ComputerUseDelivery,
): ComputerUseDelivery | null {
  const spelled =
    fields.background === undefined ? undefined : fields.background ? "background" : "foreground";
  if (fields.delivery !== undefined && spelled !== undefined && fields.delivery !== spelled) {
    return null;
  }
  return fields.delivery ?? spelled ?? userDefault;
}

export function groundDesktopV2Action(
  action: ComputerUseDesktopV2Action,
  userDefault: ComputerUseDelivery,
): DesktopV2Grounding {
  const withDelivery = (
    fields: DeliveryFields,
    extra: Omit<GroundedDesktopV2Action, "action" | "delivery"> = {},
  ): DesktopV2Grounding => {
    const delivery = resolveDelivery(fields, userDefault);
    return delivery === null
      ? refuse("delivery_conflict", "delivery")
      : { ok: true, value: { action, delivery, ...extra } };
  };
  switch (action.action) {
    case "click":
    case "drag":
    case "type":
    case "key":
    case "launch_app":
    case "navigate":
      return withDelivery(action);
    case "scroll": {
      const hasX = action.x !== undefined;
      if (hasX !== (action.y !== undefined)) return refuse("invalid_arguments", "x/y");
      if (hasX && action.observationRef === undefined) {
        return refuse("observation_missing", "observationRef");
      }
      if (!hasX && action.targetRef === undefined) return refuse("target_missing", "targetRef");
      const scroll = normalizeScroll(action.deltaX, action.deltaY);
      if (scroll === null) return refuse("invalid_arguments", "deltaX/deltaY");
      return withDelivery(action, { scroll });
    }
    case "focus_app": {
      const hasTarget = action.targetRef !== undefined;
      const hasName = action.name !== undefined;
      if (hasTarget && hasName) return refuse("selector_conflict", "targetRef/name");
      if (!hasTarget && !hasName) return refuse("target_missing", "targetRef/name");
      // Explicit focus is intentionally foreground.
      return { ok: true, value: { action, delivery: "foreground" } };
    }
    case "wait":
      // captureAfter needs the retained exact target, never a reacquired one.
      if (action.captureAfter === true && action.targetRef === undefined) {
        return refuse("target_missing", "targetRef");
      }
      return { ok: true, value: { action } };
    case "capture":
    case "get_page_info":
    case "list_apps":
    case "list_windows":
    case "get_accessibility_tree":
    case "check_permissions":
    case "doctor":
      return { ok: true, value: { action } };
  }
}
