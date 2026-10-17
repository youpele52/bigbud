import type { V2RuntimeSession } from "./Runtime.types.ts";
import { correlatedProjection, readV2Messages } from "./Runtime.projection.ts";
import { Effect } from "effect";
import type { ProviderTurnAdmissionsShape } from "../../../persistence/Services/ProviderTurnAdmissions.ts";
import type { ProviderTurnAdmission } from "@bigbud/contracts/orchestration/providerTurnAdmission.ts";

/** Snapshot only the durably owned turn; do not invent canonical identities for imported history. */
export async function readV2Thread(
  session: V2RuntimeSession,
  journal: ProviderTurnAdmissionsShape,
) {
  const messages = await readV2Messages(session);
  const rows: ProviderTurnAdmission[] = [];
  let bytes = 0;
  for (let page = 0; ; page++) {
    const batch = await Effect.runPromise(
      journal.listBoundPage({
        threadId: session.threadId,
        limit: 4,
        ...(rows.at(-1) ? { after: rows.at(-1)! } : {}),
      }),
    );
    bytes += Buffer.byteLength(JSON.stringify(batch));
    if (bytes > 8_000_000)
      throw new Error("V2 history journal byte bound exceeded; use bigbud history replay.");
    rows.push(...batch);
    if (batch.length < 4) break;
    if (page >= 2499)
      throw new Error("V2 history journal snapshot bound exceeded; use bigbud history replay.");
  }
  if (
    session.stopped ||
    rows.some(
      (row) =>
        row.binding.provider !== "opencodeV2" ||
        row.binding.nativeSessionId !== session.native.id ||
        row.binding.storageIdentity !== session.storageIdentity ||
        row.binding.location !== session.native.location.directory ||
        row.binding.runtimeTargetId !==
          (session.session.providerRuntimeExecutionTargetId ?? "local") ||
        row.binding.workspaceTargetId !== (session.session.workspaceExecutionTargetId ?? "local"),
    )
  )
    throw new Error("V2 history binding rejected.");
  return {
    threadId: session.threadId,
    turns: rows
      .filter((row) => row.state === "accepted" || row.state === "terminal")
      .map((row) => ({
        id: row.turnId,
        items: correlatedProjection({ ...session, row }, messages)?.assistants ?? [],
      })),
  };
}
