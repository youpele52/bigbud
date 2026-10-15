import type { V2_NATIVE_QUALIFICATION_SCOPES } from "./NativeCompatibility.types.ts";

/** Frozen suite identity recorded as `record.suiteRevision`. Changing the file list below requires a
 * new revision string; old evidence is never relabeled. Test/tooling metadata only. */
export const V2_NATIVE_QUALIFICATION_SUITE_REVISION = "opencode-v2-native-qualification-suite.v1";

const DIR = "src/provider/Layers/OpencodeV2";
const files = (...names: string[]) => Object.freeze(names.map((name) => `${DIR}/${name}`));

/** Scope -> vitest files (relative to apps/server), per the 2026-10-15 gap-closure plan §1.2. */
export const V2_NATIVE_QUALIFICATION_SUITE: Readonly<
  Record<(typeof V2_NATIVE_QUALIFICATION_SCOPES)[number], readonly string[]>
> = Object.freeze({
  "api-transport-admission": files(
    "SharedService.native.test.ts",
    "SharedService.application.native.test.ts",
    "SharedService.logical.native.test.ts",
    "SharedService.context.native.test.ts",
    "SharedService.model.routing.native.test.ts",
    "Runtime.native.test.ts",
  ),
  "native-tool-schema-catalog-permissions": files(
    "Runtime.tools.native.test.ts",
    "Runtime.permissions.native.test.ts",
    "Catalog.native.test.ts",
    "Orchestration.approval.native.test.ts",
    "Runtime.model.native.test.ts",
  ),
  "isolation-hooks": files(
    "SharedService.native.isolation.test.ts",
    "Execution.application.native.test.ts",
    "Execution.lifecycle.native.test.ts",
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

/** Files in the plan's mapping that cannot pass against a retail 2.0.29 image as written: the
 * private owned-process launcher requires exactly CLI 2.0.26 (`assertDevelopmentVersion`), and the
 * public catalog smoke needs internet egress. Recorded so the qualification run fails visibly
 * instead of being silently narrowed; resolving them is a plan decision (see the 2.0.29 ledger). */
export const V2_NATIVE_QUALIFICATION_BLOCKED: Readonly<Record<string, string>> = Object.freeze({
  [`${DIR}/Runtime.native.test.ts`]: "private owned-process launcher pins CLI 2.0.26",
  [`${DIR}/Runtime.tools.native.test.ts`]: "private owned-process launcher pins CLI 2.0.26",
  [`${DIR}/Runtime.permissions.native.test.ts`]: "private owned-process launcher pins CLI 2.0.26",
  [`${DIR}/Catalog.native.test.ts`]:
    "private owned-process launcher pins CLI 2.0.26; public catalog smoke needs internet egress",
  [`${DIR}/Runtime.model.native.test.ts`]: "private owned-process launcher pins CLI 2.0.26",
  [`${DIR}/Execution.application.native.test.ts`]:
    "private owned-process launcher pins CLI 2.0.26; nested seatbelt under the egress sandbox",
  [`${DIR}/Execution.lifecycle.native.test.ts`]:
    "private owned-process launcher pins CLI 2.0.26; nested seatbelt under the egress sandbox",
  [`${DIR}/Runtime.accessModes.native.test.ts`]: "private owned-process launcher pins CLI 2.0.26",
  [`${DIR}/Runtime.deletion.contract.native.test.ts`]:
    "private owned-process launcher pins CLI 2.0.26",
  [`${DIR}/Runtime.load.native.test.ts`]: "private owned-process launcher pins CLI 2.0.26",
  [`${DIR}/Runtime.context.native.test.ts`]: "private owned-process launcher pins CLI 2.0.26",
  [`${DIR}/Runtime.attachments.native.test.ts`]: "private owned-process launcher pins CLI 2.0.26",
});

/** Values fixed at preparation time (npm metadata, upstream tag, approved runner layout). */
export const V2_NATIVE_QUALIFICATION_TARGET = Object.freeze({
  nativeVersion: "2.0.29",
  platform: "darwin",
  arch: "arm64",
  semanticProfile: "v2-system-global-config-v1",
  nativeSourceCommit: "042d0832f5f3a73eaa039a58a7d565776f6d4290",
  npmPackage: "@opencode/cli-darwin-arm64",
  npmIntegrity:
    "sha512-2tJOM20RpOjNeWsYcV3VfRFPDTeu1yMMbEqAQm1sEKmHX9087Sx/TxhwBlvtiudOGq6Kr3zyKmW1t7aFF6qCsQ==",
  npmTarball: "https://registry.npmjs.org/@opencode/cli-darwin-arm64/-/cli-darwin-arm64-2.0.29.tgz",
  executableSha256: "7f46ba1dad86b730903d9adf54015bb4e706fc1ab6a247affc5a635cd8a663f3",
  approvalId: "gh-macos-15-arm64-opencode-2-0-29",
  machineId: "github-macos-15-arm64",
  runnerLabel: "macos-15",
  fixtureRoot: "/Users/runner/work/_temp/opencode-v2-qualification",
  executablePath: "/Users/runner/work/_temp/opencode-v2-qualification/fixture/package/bin/opencode",
  controlledPath: "/usr/bin:/bin:/usr/sbin:/sbin",
  egressProfile: "scripts/opencode-v2-qualification-egress.sb",
});
