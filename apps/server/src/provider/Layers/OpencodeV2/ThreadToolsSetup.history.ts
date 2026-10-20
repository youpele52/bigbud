import { decodeV2Cursor } from "./Runtime.cursor.ts";
import type { OpencodeV2SharedBinding } from "../../../persistence/Services/OpencodeV2SharedBindings.ts";

/** Local app evidence can classify retained history without touching native history or granting a capability. */
export function v2RetainedHistoryIssue(input: {
  readonly cursor?: unknown;
  readonly hasAdmission: boolean;
  readonly binding?: OpencodeV2SharedBinding | undefined;
  readonly directory: string;
}): string | undefined {
  let cursor: ReturnType<typeof decodeV2Cursor> | undefined;
  if (input.cursor !== undefined && input.cursor !== null) {
    try {
      cursor = decodeV2Cursor(input.cursor);
    } catch {
      return "Retained V2 ownership is unsupported; canonical history remains read-only without replacement or replay.";
    }
  }
  if (cursor?.connectionMode === "isolated")
    return "Retired isolated V2 history is read-only. Its transcript and bindings are retained; native history is never acquired, migrated, recreated or replayed.";
  if (
    (input.binding && input.binding.directory !== input.directory) ||
    (cursor && cursor.directory !== input.directory)
  )
    return "Retained V2 history belongs to another native Location; canonical history remains read-only here.";
  if (
    (cursor || input.hasAdmission) &&
    input.binding?.state !== "verified" &&
    cursor?.connectionMode !== "shared"
  )
    return "Unsupported retained V2 binding: shared native ownership is unproved; canonical history remains read-only without replacement or replay.";
  return undefined;
}
