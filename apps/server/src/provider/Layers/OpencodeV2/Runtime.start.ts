import { Effect } from "effect";
import { effectiveV2WorkspaceLocation } from "./Runtime.workspaceLocation.ts";
import type { OpencodeV2Runtime } from "./Runtime.ts";
import type { V2RuntimeSession } from "./Runtime.types.ts";

/** One acquisition attempt, not merely a durable thread ID, owns cancellation/cleanup. */
export class V2StartAttempt {
  readonly controller = new AbortController();
  owner: V2RuntimeSession | undefined;
  phase: "setup-wait" | "reserved" | "native-running" | "uncertain" | "settled" = "setup-wait";
}

export async function recoverV2Session(runtime: OpencodeV2Runtime, owner: V2RuntimeSession) {
  const unresolved = await Effect.runPromise(
    runtime.options.journal.listBoundPage({
      threadId: owner.threadId,
      limit: 2,
      unresolvedOnly: true,
    }),
  );
  const latest = unresolved.length
    ? undefined
    : await Effect.runPromise(runtime.options.journal.latestBound(owner.threadId));
  const owned = unresolved.length ? unresolved : latest ? [latest] : [];
  const locations = await Promise.all(
    owned.map((row) => effectiveV2WorkspaceLocation(runtime.options.journal, row.binding)),
  );
  if (
    owned.length > 1 ||
    owned.some(
      (row, index) =>
        row.binding.provider !== "opencodeV2" ||
        row.binding.nativeSessionId !== owner.native.id ||
        row.binding.storageIdentity !== owner.storageIdentity ||
        locations[index] !== owner.native.location.directory ||
        row.binding.runtimeTargetId !==
          (owner.session.providerRuntimeExecutionTargetId ?? "local") ||
        row.binding.workspaceTargetId !== (owner.session.workspaceExecutionTargetId ?? "local"),
    )
  )
    throw new Error("V2 startup journal binding mismatch.");
  owner.row = owned[0];
  owner.effectiveAdmissionLocation = locations[0];
  if (owner.row)
    owner.session = {
      ...owner.session,
      activeTurnId: owner.row.turnId,
      status: owner.row.state === "accepted" ? "running" : "error",
      lastError: "Recovered admission requires authoritative reconciliation; no automatic resend.",
    };
  if (owner.row) await runtime.reconcile(owner);
}
