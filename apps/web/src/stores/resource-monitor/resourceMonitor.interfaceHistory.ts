import type {
  MonitorNetworkInterface,
  MonitorSnapshot,
} from "@bigbud/contracts/system-monitor/types";
import {
  nextEntityTransferHistory,
  type EntityTransferHistory,
} from "./resourceMonitor.entityHistory";

export type InterfaceHistory = EntityTransferHistory;

/** Encode names safely, including interfaces whose names resemble object properties. */
export function interfaceHistoryKey(item: MonitorNetworkInterface): string {
  return JSON.stringify([item.name]);
}

/** Track each interface independently; bridge and tunnel traffic must never be summed here. */
export function nextInterfaceHistory(
  previous: MonitorSnapshot | null,
  snapshot: MonitorSnapshot,
  history: InterfaceHistory,
  continuous: boolean,
): InterfaceHistory {
  if (snapshot.summaryStatus !== "ready") return {};
  const entities = (interfaces: readonly MonitorNetworkInterface[]) =>
    interfaces.map((item) => ({
      key: interfaceHistoryKey(item),
      incoming: item.receivedBytesPerSecond,
      outgoing: item.transmittedBytesPerSecond,
    }));
  return nextEntityTransferHistory(
    entities(previous?.interfaces ?? []),
    entities(snapshot.interfaces),
    history,
    snapshot.sequence,
    continuous,
  );
}
