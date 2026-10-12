import { Effect } from "effect";
import type { ServerProvider } from "@bigbud/contracts";
import type { OpencodeV2SharedBindingsShape } from "../../../persistence/Services/OpencodeV2SharedBindings.ts";

export const V2_SHARED_DOWNGRADE_WARNING =
  "Logical native history is retained. Do not run shared execution in an older build without shared-binding recovery. Before downgrade, durably disable OpenCode v2, drain bigbud and stop the application; preserve all binding/admission records and attachments. Native service shutdown is not required.";

/** The common disabled setting is the rollback boundary, not an interlock on older binaries. */
export function warnV2SharedRollback(
  bindings: OpencodeV2SharedBindingsShape | undefined,
  snapshot: ServerProvider,
) {
  if (!bindings) return Effect.succeed(snapshot);
  return bindings.hasRecords.pipe(
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
