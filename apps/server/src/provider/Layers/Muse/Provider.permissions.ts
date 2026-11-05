import type { RuntimeMode } from "@bigbud/contracts";

/**
 * Qualified Muse access-mode mapping (Phase 0, macOS, CLI 1.4.14-R7309.1).
 *
 * Live evidence (docs/validation/muse-provider-qualification-2026-10-29.md):
 * - `:ask-me` + approvalMode `promptUnmatched`: in-workspace edits apply
 *   automatically inside the native sandbox, shell commands require native
 *   approval, out-of-workspace writes are sandbox-denied, shell network is
 *   off. This is exactly bigbud's `auto-accept-edits` promise.
 * - `approval-required` ("approve all file changes and command executions")
 *   has no native equivalent: no profile/approval-mode combination gates
 *   in-workspace file writes. Unsupported, never reinterpreted.
 * - `full-access` would require `:unrestricted`/`allowAll`; not live-qualified
 *   in Phase 0 and never derived from bigbud's global default. Unsupported.
 */
export interface MusePermissionSelection {
  readonly permissionProfile: string;
  readonly approvalMode: string;
}

export type MuseModeResolution =
  | { readonly supported: true; readonly selection: MusePermissionSelection }
  | { readonly supported: false; readonly reason: string };

export const MUSE_SUPPORTED_RUNTIME_MODES: ReadonlyArray<RuntimeMode> = ["auto-accept-edits"];

export const MUSE_UNSUPPORTED_MODE_REASON =
  "Muse Code is qualified only for auto-accept-edits (workspace edits inside the native sandbox; shell and restricted actions need native approval). Approval-required and full-access have no proven native equivalent and stay disabled. Switch this thread's Access mode to Auto-accept edits (composer ··· menu → Access), then send again.";

export function resolveMusePermissionSelection(runtimeMode: RuntimeMode): MuseModeResolution {
  if (runtimeMode === "auto-accept-edits") {
    return {
      supported: true,
      selection: { permissionProfile: ":ask-me", approvalMode: "promptUnmatched" },
    };
  }
  return { supported: false, reason: MUSE_UNSUPPORTED_MODE_REASON };
}

/** Plan mode is prompt-only on the native side and is not read-only enforcement. */
export function museInteractionModeSupported(interactionMode: string): boolean {
  return interactionMode === "default";
}

/**
 * Inherited-mode downgrade applied where Muse thread state is created,
 * continued or cloned: `full-access` in a Muse thread is almost always the
 * global default (`DEFAULT_RUNTIME_MODE`), not a Muse-specific choice, and
 * resolving it to the qualified `auto-accept-edits` is strictly less
 * privilege, so it is fail-safe. A user-chosen `approval-required` is
 * stricter than the qualified mode and is never silently upgraded; it stays
 * explicitly blocked by `resolveMusePermissionSelection`.
 */
export function downgradeMuseInheritedRuntimeMode(runtimeMode: RuntimeMode): RuntimeMode {
  return runtimeMode === "full-access" ? "auto-accept-edits" : runtimeMode;
}
