import { CUA_DRIVER_0_38_0_ARTIFACTS } from "../cua-driver/release.v0_38_0.ts";
import { parseComputerUseTupleManifest, type ComputerUseTupleManifest } from "./tuple.ts";

/**
 * Computer-use selection. Two independent layers:
 *
 * 1. Public contract profile: which tool schemas, decoding and results every
 *    consumer uses. Static, so module-level tool definitions stay constants.
 *    It is NOT derived from the pinned Driver release: a Driver bump (0.9.1
 *    <-> 0.38.0) only selects the release table. Only an explicit, approved
 *    supervised cutover may change it.
 * 2. Supervised execution gate: whether the native guard/owner path may run.
 *    Closed while the profile is `legacy`. Under `v2` the only open basis is
 *    the explicit local-development opt-in `BIGBUD_COMPUTER_USE_SUPERVISED_DEV=1`.
 *    A tuple manifest never opens it: manifest shape is not verification
 *    (`tuple.ts`), and no qualification-evidence verification exists yet. A
 *    manifest must at least name the exact target and match a non-null
 *    verified release-table entry; even then the gate stays closed
 *    (`qualification-unverified`). A closed gate under the v2 profile fails
 *    closed (`control_unavailable`); it never falls back to the legacy runtime.
 */
export const COMPUTER_USE_SUPERVISED_DEV_ENV = "BIGBUD_COMPUTER_USE_SUPERVISED_DEV";

export type ComputerUseContractProfile = "legacy" | "v2";

/**
 * `legacy` = the TypeScript-managed embedded daemon (`serve --embedded`) plus
 * the v1 public `computer_use` contract, valid for Driver 0.9.1 and 0.38.0.
 */
export const selectedComputerUseContractProfile: ComputerUseContractProfile = "legacy";

export type SupervisedExecutionGate =
  | { readonly open: true; readonly basis: "development-opt-in" }
  | {
      readonly open: false;
      readonly reason:
        | "legacy-profile"
        | "tuple-unqualified"
        | "tuple-mismatch"
        | "tuple-unverified"
        | "qualification-unverified";
    };

/**
 * The manifest's artifact hash equals the verified release-table entry for
 * its own target. The 0.38 table is filled (lean M2), so a manifest carrying
 * the real archive hash matches; the release table records only the archive
 * hash, so the binary hash is not checked here. Matching alone never opens the
 * supervised gate (the profile is a constant, see `resolveSupervisedExecutionGate`).
 */
export function manifestMatchesVerifiedArtifact(manifest: ComputerUseTupleManifest): boolean {
  const artifact = CUA_DRIVER_0_38_0_ARTIFACTS[manifest.platform][manifest.arch];
  return artifact !== null && artifact.sha256 === manifest.archiveSha256;
}

export interface SupervisedExecutionGateInput {
  readonly profile: ComputerUseContractProfile;
  readonly platform: string;
  readonly arch: string;
  /** True only for the local dev app (`VITE_DEV_SERVER_URL`), never packaged. */
  readonly development: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Qualified tuple manifest shipped with the build, when one exists. */
  readonly manifest?: unknown;
}

/** Pure; callers resolve it once at startup and never reopen it mid-operation. */
export function resolveSupervisedExecutionGate(
  input: SupervisedExecutionGateInput,
): SupervisedExecutionGate {
  if (input.profile !== "v2") return { open: false, reason: "legacy-profile" };
  if (input.manifest !== undefined) {
    let manifest;
    try {
      manifest = parseComputerUseTupleManifest(input.manifest);
    } catch {
      return { open: false, reason: "tuple-unqualified" };
    }
    if (manifest.platform !== input.platform || manifest.arch !== input.arch) {
      return { open: false, reason: "tuple-mismatch" };
    }
    return {
      open: false,
      reason: manifestMatchesVerifiedArtifact(manifest)
        ? "qualification-unverified"
        : "tuple-unverified",
    };
  }
  if (input.development && input.env[COMPUTER_USE_SUPERVISED_DEV_ENV]?.trim() === "1") {
    return { open: true, basis: "development-opt-in" };
  }
  return { open: false, reason: "tuple-unqualified" };
}
