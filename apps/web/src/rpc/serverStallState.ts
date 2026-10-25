import type { ServerStalledPayload } from "@bigbud/contracts/server/connectionDiagnostics.ts";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/unstable/reactivity";

import { appAtomRegistry } from "./atomRegistry";

export interface ServerStallNotice {
  /** Increases per received stall so repeated identical payloads still render. */
  readonly id: number;
  readonly receivedAt: number;
  readonly payload: ServerStalledPayload;
}

export const serverStallAtom = Atom.make<ServerStallNotice | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("server-stall"),
);

let nextStallId = 1;
/** The lifecycle snapshot replays recent stalls on every resubscribe; each counts once. */
const SEEN_STALL_LIMIT = 32;
const seenStallKeys: string[] = [];

function stallKey(payload: ServerStalledPayload): string {
  return `${payload.startedAt}|${payload.endedAt}`;
}

/** Records a server event-loop stall reported over the lifecycle stream once it ended. */
export function recordServerStall(payload: ServerStalledPayload): void {
  const key = stallKey(payload);
  if (seenStallKeys.includes(key)) return;
  seenStallKeys.push(key);
  if (seenStallKeys.length > SEEN_STALL_LIMIT) seenStallKeys.shift();
  appAtomRegistry.set(serverStallAtom, { id: nextStallId++, receivedAt: Date.now(), payload });
}

export function useLatestServerStall(): ServerStallNotice | null {
  return useAtomValue(serverStallAtom);
}

export function resetServerStallStateForTests(): void {
  appAtomRegistry.set(serverStallAtom, null);
  nextStallId = 1;
  seenStallKeys.length = 0;
}
