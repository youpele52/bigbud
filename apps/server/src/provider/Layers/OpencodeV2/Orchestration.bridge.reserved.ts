import { isDeepStrictEqual } from "node:util";
import * as Effect from "effect/Effect";
import type { OpencodeV2Runtime } from "./Runtime.ts";
import type { V2RuntimeSession } from "./Runtime.types.ts";
import { v2Request } from "./Client.ts";

/** A stopped preparer may retire its tools without erasing or replaying its exact reserved request. */
export async function v2ReservedRetirementDrained(
  runtime: OpencodeV2Runtime,
  session: V2RuntimeSession,
  signal?: AbortSignal,
) {
  const row = session.row;
  const epoch = session.epoch;
  const stopped = session.stopped;
  if (!row || row.state !== "reserved" || session.admissionInFlight) return false;
  const current = () =>
    session.row === row &&
    session.epoch === epoch &&
    session.stopped === stopped &&
    runtime.sessions.get(session.threadId) === session &&
    !session.admissionInFlight &&
    !session.family?.live &&
    !session.family?.persistenceUncertain &&
    !session.familyControl?.busyCount?.() &&
    session.lease.process.isRunning();
  if (!current()) return false;
  const active = await v2Request(
    "reserved retirement active drain",
    (abort) => session.lease.process.client.session.active({ signal: abort }),
    { timeoutMs: 5000, ...(signal ? { signal } : {}) },
  );
  if (active[session.native.id] || !current()) return false;
  const inbox = await v2Request(
    "reserved retirement input drain",
    (abort) =>
      session.lease.process.client.session.inbox.list(
        { sessionID: session.native.id },
        { signal: abort },
      ),
    { timeoutMs: 5000, ...(signal ? { signal } : {}) },
  );
  if (inbox.length || !current()) return false;
  const rows = await Effect.runPromise(
    runtime.options.journal.listBoundPage({
      threadId: session.threadId,
      limit: 2,
      unresolvedOnly: true,
    }),
  );
  signal?.throwIfAborted();
  return current() && rows.length === 1 && isDeepStrictEqual(rows[0], row);
}
