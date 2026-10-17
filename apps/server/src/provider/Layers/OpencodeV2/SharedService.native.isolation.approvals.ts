import type { V2NativeIsolationApproval } from "./SharedService.native.isolation.fixture.ts";

/** Parent-approved clean-runner records only. HOME overrides and environment assertions cannot
 * create these records; none is approved yet. This catalog is test-only, never production policy.
 * Add an entry only from a provisioning run's generated approval
 * (`apps/server/scripts/assembleThreadToolNativeQualification.ts provision`), never by hand. */
export const V2_NATIVE_ISOLATION_APPROVALS: readonly V2NativeIsolationApproval[] = Object.freeze(
  [],
);
