/**
 * Dormant v2 request classification (plan M3 "Freeze the public v2 wire
 * contract"): browser requests (including the legacy omitted-surface default
 * for shared actions) keep their old schema; a desktop request
 * without `schemaVersion: 2` refuses with `version_required` (legacy
 * ungrounded desktop mutations are never silently adapted); raw PID/window
 * selectors refuse as `selector_conflict`; anything else that fails the
 * closed union is `invalid_arguments`. Not called while legacy is selected.
 */
import {
  ComputerUseDesktopV2Action,
  type ComputerUseV2ErrorCode,
} from "@bigbud/contracts/orchestration/computerUseDesktopV2";
import { Schema } from "effect";

import { isComputerUseSurface, resolveComputerUseSurface } from "./surface";

export type DesktopV2Request =
  | { readonly kind: "browser" }
  | { readonly kind: "desktop_v2"; readonly action: ComputerUseDesktopV2Action }
  | { readonly kind: "refused"; readonly code: ComputerUseV2ErrorCode };

const decodeAction = Schema.decodeUnknownOption(ComputerUseDesktopV2Action);
const refused = (code: ComputerUseV2ErrorCode): DesktopV2Request => ({ kind: "refused", code });

export function classifyDesktopV2Request(raw: unknown): DesktopV2Request {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return refused("invalid_arguments");
  }
  const fields = raw as Record<string, unknown>;
  const surface = fields.surface;
  if (surface !== undefined && !isComputerUseSurface(surface)) return refused("invalid_arguments");
  // Same rule as the legacy route: omitted surface keeps the browser default.
  const action = typeof fields.action === "string" ? fields.action : "";
  if (resolveComputerUseSurface(action, surface) === "browser") return { kind: "browser" };
  if (fields.schemaVersion !== 2) return refused("version_required");
  if (Object.hasOwn(fields, "pid") || Object.hasOwn(fields, "windowId")) {
    return refused("selector_conflict");
  }
  const decoded = decodeAction(raw, { onExcessProperty: "error" });
  return decoded._tag === "Some"
    ? { kind: "desktop_v2", action: decoded.value }
    : refused("invalid_arguments");
}
