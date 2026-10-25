import type { OpenCodeClient, PermissionRuleset, SessionInfo } from "@opencode/client";
import { v2Request } from "./Client.ts";
import { v2SavedGrantMayBypassAsk } from "./Runtime.permissions.overlap.ts";

export class V2SavedPermissionConflict extends Error {
  constructor() {
    super(
      "V2 project has saved native approvals that overlap permissions requiring approval in this access mode. Review the relevant approvals in OpenCode before retrying; bigbud does not delete them or change your access mode.",
    );
    this.name = "V2SavedPermissionConflict";
  }
}

/** V2 saved allows satisfy asks, but never configured denies; unrelated approvals are not blockers. */
export async function assertV2SavedGrantsCompatible(
  client: OpenCodeClient,
  native: SessionInfo,
  policy: PermissionRuleset = native.permissions ?? [],
) {
  const grants = await v2Request("permission.saved.list", (signal) =>
    client.permission.saved.list({ projectID: native.projectID }, { signal }),
  );
  if (grants.length > 128) throw new Error("V2 saved permission inventory exceeds bound.");
  if (grants.some((grant) => grant.projectID !== native.projectID))
    throw new Error("V2 saved permission project identity mismatch.");
  if (grants.some((grant) => v2SavedGrantMayBypassAsk(policy, grant)))
    throw new V2SavedPermissionConflict();
}
