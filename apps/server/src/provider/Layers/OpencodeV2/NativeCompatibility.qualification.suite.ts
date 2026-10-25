import type { V2_NATIVE_QUALIFICATION_SCOPES } from "./NativeCompatibility.types.ts";

/** Frozen suite identity recorded as `record.suiteRevision`. Changing the file list below requires a
 * new revision string; old evidence is never relabeled. Test/tooling metadata only.
 * v1 was the 2026-10-15 plan §1.2 list; v2 (Amendment 2026-10-15) runs every scope on the shared
 * production path only: owned-launcher files were ported to the approval-gated shared fixture or
 * excluded below. v1 never executed. */
export const V2_NATIVE_QUALIFICATION_SUITE_REVISION = "opencode-v2-native-qualification-suite.v2";

const DIR = "src/provider/Layers/OpencodeV2";
const files = (...names: string[]) => Object.freeze(names.map((name) => `${DIR}/${name}`));

/** Scope -> vitest files (relative to apps/server). Every file obtains its native service through
 * `sharedServiceNativeFixture` (approval-gated retail child, borrowed) or is a non-native unit test. */
export const V2_NATIVE_QUALIFICATION_SUITE: Readonly<
  Record<(typeof V2_NATIVE_QUALIFICATION_SCOPES)[number], readonly string[]>
> = Object.freeze({
  "api-transport-admission": files(
    "SharedService.native.test.ts",
    "SharedService.application.native.test.ts",
    "SharedService.logical.native.test.ts",
    "Runtime.native.test.ts",
  ),
  "native-tool-schema-catalog-permissions": files(
    "SharedService.context.native.test.ts",
    "SharedService.model.routing.native.test.ts",
    "Runtime.permissions.native.test.ts",
    "Orchestration.approval.native.test.ts",
  ),
  "isolation-hooks": files(
    "SharedService.native.isolation.test.ts",
    "ServerManager.retail.isolation.test.ts",
    "Runtime.accessModes.native.test.ts",
  ),
  "rpc-crypto-cancellation": files(
    "Orchestration.plugin.native.test.ts",
    "Orchestration.production.native.test.ts",
    "Orchestration.readiness.failure.native.test.ts",
  ),
  "history-receipt-approval-integration": files(
    "SharedService.history.native.test.ts",
    "Orchestration.lifecycle.native.test.ts",
    "Runtime.deletion.contract.native.test.ts",
    "Runtime.load.native.test.ts",
  ),
  "source-config-autoload": files(
    "PluginSetup.autoload.native.test.ts",
    "PluginSetup.application.native.test.ts",
    "NativeCompatibility.sources.test.ts",
  ),
  "two-location-lifecycle": files(
    "Orchestration.stable.native.test.ts",
    "Runtime.context.native.test.ts",
    "Runtime.attachments.native.test.ts",
  ),
  "packaged-ab": files("Orchestration.production.packaged.test.ts", "Packaging.artifacts.test.ts"),
});

/** v1 files deliberately not run by v2, with the reason and the covering suite file where one
 * exists. All but Catalog.native (kept as a public-network smoke) were deleted in gap-closure Phase
 * 4.1 because they only exercised retired owned/private paths. */
export const V2_NATIVE_QUALIFICATION_EXCLUDED: Readonly<Record<string, string>> = Object.freeze({
  [`${DIR}/Runtime.tools.native.test.ts`]:
    "retired remote-session conformance (ssh workspace target, hidden local tools); the shared adapter cannot construct it. Shared tool schema: SharedService.context.native",
  [`${DIR}/Catalog.native.test.ts`]:
    "public-network catalog smoke (BIGBUD_OPENCODE_V2_PUBLIC_CATALOG_SMOKE=1), incompatible with loopback-only egress; kept as a separate non-qualification test",
  [`${DIR}/Runtime.model.native.test.ts`]:
    "covered on the shared path by SharedService.model.routing.native (model/variant switch keeps session and history, original replay not resent)",
  [`${DIR}/Execution.application.native.test.ts`]:
    "retired isolated coding bridge (bigbud_shell/bigbud_orchestration, seatbelt executor) that the shared adapter omits; canonical child creation: Orchestration.approval.native and Orchestration.production.native",
  [`${DIR}/Execution.lifecycle.native.test.ts`]:
    "retired isolated contained-executor teardown (bigbud_shell, seatbelt) that the shared adapter omits; shared interrupt/teardown: Runtime.native and Orchestration.lifecycle.native",
});

/** Values fixed at preparation time (npm metadata, upstream tag, approved runner layout). */
export const V2_NATIVE_QUALIFICATION_TARGET = Object.freeze({
  nativeVersion: "2.1.4",
  platform: "darwin",
  arch: "arm64",
  semanticProfile: "v2-system-global-config-v1",
  nativeSourceCommit: "68bc26b7da1990ce10ffecfbc1e09eb13aa5d824",
  npmPackage: "@opencode/cli-darwin-arm64",
  npmIntegrity:
    "sha512-QwjyvovTdT0gFi5rxUyPVlYePIe3ELduR9olu+KJWe089XVIDOTMhxylBe/ZGIpvoXHYo6bp2NskIiqCFAEXsw==",
  npmTarball: "https://registry.npmjs.org/@opencode/cli-darwin-arm64/-/cli-darwin-arm64-2.1.4.tgz",
  executableSha256: "d8a65dd253dbea759ae0dd829792ff219b40178c7decffea822430a4d1ccadb3",
  approvalId: "gh-macos-15-arm64-opencode-2-1-4",
  machineId: "github-macos-15-arm64",
  runnerLabel: "macos-15",
  fixtureRoot: "/Users/runner/work/_temp/opencode-v2-qualification",
  executablePath: "/Users/runner/work/_temp/opencode-v2-qualification/fixture/package/bin/opencode",
  controlledPath: "/usr/bin:/bin:/usr/sbin:/sbin",
  egressProfile: "scripts/opencode-v2-qualification-egress.sb",
});
