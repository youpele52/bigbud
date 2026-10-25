import { BrowserWindow, net, powerMonitor } from "electron";
import type { DesktopConnectivitySignal } from "@bigbud/contracts/server/ipc.desktop.ts";

import {
  isDesktopLifecycleHintKind,
  writeBackendLifecycleHint,
} from "../backend/backendLifecycleHintPipe";
import { backendWsUrl, restartUnresponsiveBackend } from "../backend/backendManager";
import { probeBackendAfterResume } from "../backend/backendResumeProbe";
import {
  getBackendStartupState,
  republishBackendStartupState,
} from "../backend/backendStartupState";
import { DesktopConnectivitySignals } from "./connectivitySignals";

interface StartDesktopConnectivitySignalsOptions {
  readonly channel: string;
  readonly getIsQuitting: () => boolean;
  readonly logHeader: (message: string) => void;
}

let activeSignals: DesktopConnectivitySignals | null = null;

function broadcast(channel: string, signal: DesktopConnectivitySignal): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, signal);
  }
}

/**
 * Sends power and network hints to the server over the fd 5 pipe, so the server
 * hears about sleep even with no renderer window. Runs synchronously inside the
 * power event handler; the pipe writes a Linux `suspend` line synchronously.
 */
function forwardToBackend(signal: DesktopConnectivitySignal): void {
  if (!isDesktopLifecycleHintKind(signal.kind)) return;
  writeBackendLifecycleHint({
    kind: signal.kind,
    occurredAt: signal.occurredAt,
    online: signal.online,
  });
}

/** Publishes power and network hints next to backend startup state, and probes on wake. */
export function startDesktopConnectivitySignals(
  options: StartDesktopConnectivitySignalsOptions,
): DesktopConnectivitySignals {
  activeSignals?.stop();
  const signals = new DesktopConnectivitySignals({
    powerMonitor,
    isOnline: () => net.isOnline(),
    platform: process.platform,
    log: options.logHeader,
    publish: (signal) => {
      forwardToBackend(signal);
      broadcast(options.channel, signal);
    },
    onResume: () => {
      void probeBackendAfterResume({
        getWsUrl: () => backendWsUrl,
        getStartupState: getBackendStartupState,
        getIsQuitting: options.getIsQuitting,
        republish: republishBackendStartupState,
        restart: restartUnresponsiveBackend,
        log: (event, details) => options.logHeader(`backend ${event} ${details}`),
      }).catch((error: unknown) => {
        options.logHeader(`backend resume_probe_failed error=${String(error)}`);
      });
    },
  });
  signals.start();
  activeSignals = signals;
  return signals;
}

/** Quit teardown: removes the power listeners and the online poll. Idempotent. */
export function stopDesktopConnectivitySignals(): void {
  activeSignals?.stop();
  activeSignals = null;
}
