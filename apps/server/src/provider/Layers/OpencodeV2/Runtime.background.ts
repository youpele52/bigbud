import type { SessionMessageInfo } from "@opencode/client";
import type { V2RuntimeSession } from "./Runtime.types.ts";
import type { V2TurnProjection } from "./Runtime.background.projection.ts";
import { v2Request } from "./Client.ts";
import { readV2Messages } from "./Runtime.projection.ts";
import { assertV2SharedSessionOwner } from "./Runtime.ownership.ts";

/** Safe diagnostic: never includes native responses or connection credentials. */
export class V2BackgroundContractError extends Error {
  constructor() {
    super(
      "V2 background shell recovery is verified only for native 2.0.32. This native version remains unqualified; history and admission are retained, with no automatic resend.",
    );
  }
}

/** Quiescence observations under the pinned native shell contract, never an atomic settlement proof.
 * bigbud alone admits inputs to this exact owned conversation; other CLI conversations are independent.
 * Live-only SSE fences observed arrivals, not arbitrary external writers into this same conversation.
 * v2.0.32: tool/plugin/shell.ts registers each notification before returning its shell ID;
 * session/projector.ts projects it on InboxDelivered, not enqueue. runner/llm.ts makes a
 * later wake with no pending input a no-op. An idle alone proves none of these facts.
 * Source: https://github.com/anomalyco/opencode/tree/v2.0.32/packages/core/src
 */
export async function verifyV2BackgroundProjection(
  session: V2RuntimeSession,
  projection: V2TurnProjection,
  messages: readonly SessionMessageInfo[],
  validate: () => void,
): Promise<boolean> {
  if (!projection.background) return true;
  const info = await v2Request("background native contract", (signal) =>
    session.lease.process.client.server.info({ signal }),
  );
  validate();
  if (info.version !== "2.0.32") throw new V2BackgroundContractError();
  if (!projection.idle || projection.background.pending) return false;
  await assertV2SharedSessionOwner(session);
  validate();
  const client = session.lease.process.client;
  const inbox = await v2Request("background continuation inbox", (signal) =>
    client.session.inbox.list({ sessionID: session.native.id }, { signal }),
  );
  validate();
  if (inbox.length) return false;
  const directory = session.native.location.directory;
  const shells = await v2Request("background owned shell drain", (signal) =>
    client.shell.list({ location: { directory } }, { signal }),
  );
  validate();
  if (
    shells.location.directory !== directory ||
    !Array.isArray(shells.data) ||
    shells.data.length > 1000 ||
    shells.data.some(
      (shell) =>
        !["running", "exited", "timeout", "killed"].includes(shell.status) ||
        typeof shell.id !== "string" ||
        !shell.metadata ||
        typeof shell.metadata !== "object" ||
        Array.isArray(shell.metadata),
    )
  )
    throw new Error("V2 background shell inventory unconfirmed; admission retained.");
  if (
    shells.data.some(
      (shell) =>
        shell.status === "running" &&
        (shell.metadata.sessionID === session.native.id ||
          projection.background!.shellIds.includes(shell.id)),
    )
  )
    return false;
  // Shell GET retention is bounded and 404 is not settlement evidence. Delivered matching
  // notifications close the durable jobs; re-read the full projection to reject changed output.
  const fresh = await readV2Messages(session);
  validate();
  if (JSON.stringify(fresh) !== JSON.stringify(messages)) return false;
  const active = await v2Request("background continuation execution drain", (signal) =>
    client.session.active({ signal }),
  );
  validate();
  if (
    !active ||
    typeof active !== "object" ||
    Array.isArray(active) ||
    Object.keys(active).length > 1000 ||
    Object.values(active).some((value) => !value || value.type !== "running")
  )
    throw new Error("V2 background execution inventory unconfirmed; admission retained.");
  return !active[session.native.id];
}
