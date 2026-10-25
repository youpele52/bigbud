import type { SessionInfo } from "@opencode/client";
import { v2Request } from "./Client.ts";
import type { V2RuntimeSession } from "./Runtime.types.ts";
import { decodeV2NativeSession } from "./Runtime.session.decode.ts";
import { V2_SUBAGENT_MAX_CHILDREN, v2ObservedChildren } from "./Runtime.subagents.map.ts";

const OBSERVER_TIMEOUT_MS = 5_000;

/** Complete bounded parent-scoped inventory, never an execution/cleanup ownership grant. */
export async function readV2ObservedChildren(session: V2RuntimeSession, validate: () => void) {
  const client = session.lease.process.client;
  const children: SessionInfo[] = [];
  const ids = new Set<string>(),
    cursors = new Set<string>();
  const signal = AbortSignal.timeout(OBSERVER_TIMEOUT_MS);
  let cursor: string | undefined;
  for (let page = 0; ; page++) {
    validate();
    const listing = await v2Request(
      "session.list",
      (signal) =>
        client.session.list(
          {
            parentID: session.native.id,
            limit: V2_SUBAGENT_MAX_CHILDREN,
            ...(cursor ? { cursor } : {}),
          },
          { signal },
        ),
      { timeoutMs: OBSERVER_TIMEOUT_MS, signal },
    );
    validate();
    if (
      !Array.isArray(listing.data) ||
      listing.data.length > V2_SUBAGENT_MAX_CHILDREN ||
      !listing.cursor ||
      typeof listing.cursor !== "object" ||
      Array.isArray(listing.cursor)
    )
      throw new Error("V2 child observation page exceeds bound.");
    for (const entry of v2ObservedChildren(listing.data, session.native.id)) {
      const child = decodeV2NativeSession(entry);
      if (
        ids.has(child.id) ||
        children.length >= V2_SUBAGENT_MAX_CHILDREN ||
        child.projectID !== session.native.projectID ||
        child.location.directory !== session.native.location.directory
      )
        throw new Error("V2 child observation identity/capacity is unconfirmed.");
      ids.add(child.id);
      children.push(child);
    }
    const next = listing.cursor?.next;
    if (next === undefined || next === null) break;
    if (
      typeof next !== "string" ||
      !next.length ||
      next.length > 4096 ||
      !listing.data.length ||
      cursors.has(next) ||
      page >= V2_SUBAGENT_MAX_CHILDREN
    )
      throw new Error("V2 child observation pagination is incomplete.");
    cursors.add(next);
    cursor = next;
  }
  const active =
    children.length === 0
      ? {}
      : await v2Request("session.active", (signal) => client.session.active({ signal }), {
          timeoutMs: OBSERVER_TIMEOUT_MS,
          signal,
        });
  validate();
  if (
    !active ||
    typeof active !== "object" ||
    Array.isArray(active) ||
    Object.keys(active).length > 1000 ||
    Object.values(active).some((value) => !value || value.type !== "running")
  )
    throw new Error("V2 child activity inventory is unconfirmed.");
  return { children, active };
}
