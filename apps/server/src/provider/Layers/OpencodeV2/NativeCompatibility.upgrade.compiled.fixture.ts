import {
  selectV2NativeConfigProfile,
  projectV2NativeConfigSources,
} from "./NativeCompatibility.sources.ts";
import { v2UpgradeSources } from "./NativeCompatibility.upgrade.fixture.ts";
import {
  assertV2RequiredToolPolicies,
  assertV2RawPolicyProjection,
} from "./PluginSetup.policy.native.ts";
import { OpencodeV2ServerManager } from "./ServerManager.ts";
import { V2SharedServiceError } from "./SharedService.errors.ts";
import { v2ExecutionIssue, v2ExecutionFailureClass } from "./Adapter.execution.errors.ts";
import { ProviderAdapterValidationError } from "../../Errors.ts";

/** Offline changed-path check, bundled by the release compiler; never a native qualification. */
export async function runV2UpgradeCompiledFixture() {
  const supported: string[] = [];
  for (const version of ["2.1.4", "2.2.0"] as const) {
    const entries = v2UpgradeSources("/fixture/global", version, { platform: "darwin" });
    supported.push(selectV2NativeConfigProfile(entries, "/fixture/global", { platform: "darwin" }));
    const projection = projectV2NativeConfigSources(entries);
    assertV2RequiredToolPolicies(
      projection.flatMap((entry) => (entry.type === "document" ? [entry.info] : [])),
      ["bigbud_thread_v1_list_threads"],
    );
    if (JSON.stringify(projection).includes("DO-NOT-CARRY"))
      throw new Error("Projection redaction failed.");
  }
  let denied = "";
  try {
    assertV2RequiredToolPolicies(
      [{ policies: [{ action: "tool.use", resource: "*", effect: "deny" }] }],
      ["bigbud_thread_v1_list_threads"],
    );
  } catch (error) {
    denied = v2ExecutionIssue(error);
  }
  const rawDeny = { action: "tool.use", resource: "*", effect: "deny" };
  const policyReviewBlocked: string[] = [];
  for (const run of [
    () =>
      assertV2RequiredToolPolicies(
        [{ policies: [{ ...rawDeny, resource: "*private:*" }] }],
        ["bigbud_thread_v1_list_threads"],
      ),
    () => assertV2RawPolicyProjection({ policies: [rawDeny] }, { policies: [] }),
    () =>
      assertV2RawPolicyProjection(
        { policies: [rawDeny] },
        { policies: [{ ...rawDeny, effect: "allow" }] },
      ),
    () => assertV2RawPolicyProjection({ experimental: { policies: [rawDeny] } }, { policies: [] }),
  ]) {
    let issue = "";
    try {
      run();
    } catch (error) {
      issue = v2ExecutionIssue(error);
    }
    if (!issue.includes('"code":"policy-unsupported"'))
      throw new Error("Bounded policy review regression was not blocked.");
    policyReviewBlocked.push("policy-unsupported");
  }
  const manager = new OpencodeV2ServerManager({
    maxProcesses: 1,
    maxOwners: 1,
    maxQueuedEvents: 1,
    maxEventBytes: 1024,
    consumerTimeoutMs: 100,
    start: async () => {
      throw new V2SharedServiceError(
        "generation",
        "password /private/account https://private.test",
        "private-version",
      );
    },
  });
  try {
    await manager.acquire({
      runtimeTargetId: "local",
      binaryPath: "/fixture/cli",
      profileRoot: "/fixture/profile",
    });
    throw new Error("Expected classified acquisition failure.");
  } catch (error) {
    const issue = v2ExecutionIssue(error);
    const serialized = JSON.stringify(
      new ProviderAdapterValidationError({
        provider: "opencodeV2",
        operation: "startSession",
        issue,
        failureClass: v2ExecutionFailureClass(error, issue),
        cause: { name: error instanceof Error ? error.name : "UnknownFailure" },
      }),
    );
    if (/password|private|account/.test(serialized))
      // oxlint-disable-next-line preserve-caught-error -- The fixture must never attach the private native cause.
      throw new Error("Diagnostic redaction failed.");
    return { supported, denied, serialized, policyReviewBlocked, nativeQualified: false };
  } finally {
    await manager.close();
  }
}
