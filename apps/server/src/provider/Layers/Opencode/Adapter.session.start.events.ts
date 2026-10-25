import type { ActiveOpencodeSession } from "./Adapter.types.ts";
import type { StartSessionDeps } from "./Adapter.session.start.ts";
import { startEventStream } from "./Adapter.stream.ts";

export function attachOpencodeEventStream(
  deps: Pick<
    StartSessionDeps,
    | "provider"
    | "handleEventFn"
    | "syntheticEventFn"
    | "emitFn"
    | "services"
    | "reconcileActiveTurn"
  >,
  record: ActiveOpencodeSession,
  onInvalidated?: (callback: () => void) => () => void,
): void {
  const stream = startEventStream(
    record,
    deps.handleEventFn,
    deps.syntheticEventFn,
    deps.emitFn,
    deps.services,
    deps.reconcileActiveTurn,
    undefined,
    deps.provider,
  );
  record.stopEventStream = stream.stop;
  record.unsubscribeServerInvalidation = onInvalidated?.(stream.invalidate);
}
