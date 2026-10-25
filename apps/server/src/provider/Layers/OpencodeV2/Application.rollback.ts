import { Effect } from "effect";
import type { ServerProvider } from "@bigbud/contracts";
import { OPENCODE_RETAINED_HISTORY_ADVISORY } from "@bigbud/shared/opencodeAdvisory";
import type { OpencodeV2SharedBindingsShape } from "../../../persistence/Services/OpencodeV2SharedBindings.ts";

export const V2_SHARED_DOWNGRADE_WARNING = OPENCODE_RETAINED_HISTORY_ADVISORY;

/** The common disabled setting is the rollback boundary, not an interlock on older binaries. */
export function warnV2SharedRollback(
  bindings: OpencodeV2SharedBindingsShape | undefined,
  snapshot: ServerProvider,
) {
  if (!bindings) return Effect.succeed(snapshot);
  return bindings.hasRecords.pipe(
    // oxlint-disable-next-line no-map-spread -- copy-on-write required; the snapshot is shared provider state
    Effect.map((present) =>
      present
        ? {
            ...snapshot,
            status: "warning" as const,
            message: [snapshot.message, V2_SHARED_DOWNGRADE_WARNING].filter(Boolean).join(" "),
          }
        : snapshot,
    ),
  );
}
