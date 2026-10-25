import type { DesktopConnectivitySignal } from "@bigbud/contracts/server/ipc.desktop.ts";
import type { DesktopBridge } from "@bigbud/contracts/server/ipc.ts";

type ConnectivityBridge = Pick<DesktopBridge, "onConnectivitySignal">;

const noop = () => undefined;

/** Subscribes to Electron power and network hints, dropping replays and out-of-order copies. */
export function subscribeDesktopConnectivitySignals(
  bridge: ConnectivityBridge | undefined,
  listener: (signal: DesktopConnectivitySignal) => void,
): () => void {
  if (!bridge?.onConnectivitySignal) return noop;
  let lastSequence = 0;
  return bridge.onConnectivitySignal((signal) => {
    if (signal.sequence <= lastSequence) return;
    lastSequence = signal.sequence;
    listener(signal);
  });
}
