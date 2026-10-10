import type { OpenCodeClient, SessionInfo } from "@opencode/client";
import { v2Request } from "./Client.ts";

/** Saved project grants can override session ask rules; never silently inherit them or delete user approvals. */
export async function assertV2NoSavedGrants(client: OpenCodeClient, native: SessionInfo) {
  const grants = await v2Request("permission.saved.list", (signal) =>
    client.permission.saved.list({ projectID: native.projectID }, { signal }),
  );
  if (grants.length > 128) throw new Error("V2 saved permission inventory exceeds bound.");
  if (grants.some((grant) => grant.projectID !== native.projectID))
    throw new Error("V2 saved permission project identity mismatch.");
  if (grants.length)
    throw new Error(
      "V2 project has saved native approvals that can bypass bigbud access modes. Review them in OpenCode before starting work; bigbud never deletes user approvals automatically.",
    );
}
