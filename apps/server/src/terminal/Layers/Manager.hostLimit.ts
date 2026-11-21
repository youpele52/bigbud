/**
 * The host's live limit (plan §8.8, D7): a refused create becomes `TerminalLimitError` naming
 * the pane the host would close, and an open with `evict` passes that pane's `pty_id` so the
 * host closes it atomically before admitting the new one.
 *
 * @module Manager.hostLimit
 */
import {
  TERMINAL_LIVE_LIMIT_DEFAULT,
  TerminalLimitError,
  type TerminalEvictTarget,
  type TerminalLimitCandidate,
} from "@bigbud/contracts/workspace/terminal.limit.ts";
import * as Effect from "effect/Effect";

import { RemoteAgentPtyLimitError } from "../../remote-agent/remoteAgentPtyClient.types.ts";
import { REMOTE_AGENT_PTY_LIMIT_REACHED } from "../../remote-agent/remoteAgentProtocol.ptyLifecycle.ts";
import type { OwnedPtyRuntime } from "../Services/OwnedPtyRuntime.ts";
import type { PtySpawnHostLifecycle } from "../Services/PTY.ts";
import { ownedTerminalOwnerRouteKey } from "./OwnedPtyRuntime.owner.ts";
import type { TerminalHostRosterEntry } from "./Manager.hostRoster.ts";
import type { TerminalSessionState } from "./Manager.types.ts";

const MAX_CAUSE_DEPTH = 8;

/** The host's limit refusal, which may arrive as the `cause` of one or more spawn errors. */
export function findTerminalHostLimitError(error: unknown): RemoteAgentPtyLimitError | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current; depth++) {
    if (current instanceof RemoteAgentPtyLimitError) return current;
    if (
      typeof current === "object" &&
      (current as { code?: unknown }).code === REMOTE_AGENT_PTY_LIMIT_REACHED &&
      current instanceof Error
    )
      return new RemoteAgentPtyLimitError(current.message, {});
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Owner key `terminal:["thread","terminal"]` back to its pane. */
export function paneFromOwnerKey(
  ownerKey: string,
): { readonly threadId: string; readonly terminalId: string } | undefined {
  if (!ownerKey.startsWith("terminal:")) return undefined;
  try {
    const parsed: unknown = JSON.parse(ownerKey.slice("terminal:".length));
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === "string" &&
      typeof parsed[1] === "string"
    )
      return { threadId: parsed[0], terminalId: parsed[1] };
  } catch {
    // Not an application pane route.
  }
  return undefined;
}

export interface TerminalHostLimitContext {
  readonly sessions: () => Effect.Effect<ReadonlyArray<TerminalSessionState>>;
  readonly roster: () => ReadonlyArray<TerminalHostRosterEntry>;
  readonly runtime: OwnedPtyRuntime | undefined;
  readonly now?: () => number;
}

/** The refusal as the contract error; the candidate is null when the host named none. */
export const toTerminalLimitError = Effect.fn("terminal.toTerminalLimitError")(function* (
  ctx: TerminalHostLimitContext,
  refusal: RemoteAgentPtyLimitError,
) {
  const limit = refusal.limit && refusal.limit > 0 ? refusal.limit : TERMINAL_LIVE_LIMIT_DEFAULT;
  const liveCount = refusal.liveCount ?? limit;
  const ptyId = refusal.evictionCandidatePtyId;
  const candidate = ptyId ? yield* resolveLimitCandidate(ctx, ptyId) : null;
  return new TerminalLimitError({ limit, liveCount, candidate });
});

const resolveLimitCandidate = Effect.fn("terminal.resolveLimitCandidate")(function* (
  ctx: TerminalHostLimitContext,
  ptyId: string,
) {
  const now = ctx.now?.() ?? Date.now();
  const session = (yield* ctx.sessions()).find(
    (entry) => entry.process?.remoteResourceId === ptyId || entry.host?.ptyId === ptyId,
  );
  const rostered = ctx.roster().find((entry) => entry.ptyId === ptyId);
  const pane = session ?? rostered ?? (yield* paneForPtyId(ctx.runtime, ptyId));
  if (!pane) return null;
  const activity = session?.host?.activity;
  const lastUsedMs =
    rostered?.lastUsedMs ??
    (activity && activity.lastInputMs > 0 ? activity.lastInputMs : undefined) ??
    now;
  const busy =
    rostered?.activityState === "busy" ||
    activity?.pressureBusy === true ||
    activity?.idleBusy === true;
  return {
    threadId: pane.threadId,
    terminalId: pane.terminalId,
    lastUsedAt: new Date(lastUsedMs).toISOString(),
    busy,
  } satisfies TerminalLimitCandidate;
});

/** Pages the durable owners for the PTY's pane (only when no session or roster entry has it). */
const paneForPtyId = Effect.fn("terminal.paneForPtyId")(function* (
  runtime: OwnedPtyRuntime | undefined,
  ptyId: string,
) {
  const list = runtime?.owners().listTerminalOwners;
  if (!runtime || !list) return undefined;
  return yield* Effect.tryPromise(async () => {
    let cursor: string | undefined;
    for (let page = 0; page < 64; page++) {
      const result = await list(runtime.targetId, cursor, 100);
      const owner = result.owners.find((entry) => entry.resourceId === ptyId);
      if (owner) return paneFromOwnerKey(owner.ownerKey);
      if (!result.nextCursor) return undefined;
      cursor = result.nextCursor;
    }
    return undefined;
  }).pipe(Effect.orElseSucceed(() => undefined));
});

/** The host create option that closes `evict` first; nothing when it has no live PTY. */
export const resolveTerminalEvictLifecycle = Effect.fn("terminal.resolveEvictLifecycle")(
  function* (input: {
    readonly evict: TerminalEvictTarget | undefined;
    readonly sessions: () => Effect.Effect<ReadonlyArray<TerminalSessionState>>;
    readonly runtime: OwnedPtyRuntime | undefined;
  }) {
    const evict = input.evict;
    if (!evict || !input.runtime) return undefined;
    const session = (yield* input.sessions()).find(
      (entry) => entry.threadId === evict.threadId && entry.terminalId === evict.terminalId,
    );
    const live = session?.process?.remoteResourceId;
    if (live) return { evictPtyId: live } satisfies PtySpawnHostLifecycle;
    const runtime = input.runtime;
    const owner = yield* Effect.tryPromise(() =>
      runtime.owners().get(ownedTerminalOwnerRouteKey(evict.threadId, evict.terminalId)),
    ).pipe(Effect.orElseSucceed(() => undefined));
    return owner && owner.state !== "terminal"
      ? ({ evictPtyId: owner.resourceId } satisfies PtySpawnHostLifecycle)
      : undefined;
  },
);
