import type {
  DesktopConnectivitySignal,
  DesktopConnectivitySignalKind,
} from "@bigbud/contracts/server/ipc.desktop.ts";

/** Coarse network poll; Electron has no network-change event in the main process. */
export const CONNECTIVITY_ONLINE_POLL_MS = 10_000;
/** Repeats of one kind inside this window collapse into one hint (macOS can fire resume twice). */
export const CONNECTIVITY_COALESCE_MS = 1_000;
/** A poll tick this late means the machine slept, even if no resume event arrived. */
export const CONNECTIVITY_SLEEP_GAP_MS = CONNECTIVITY_ONLINE_POLL_MS * 3;

type PowerEvent = "suspend" | "resume" | "lock-screen" | "unlock-screen";
const POWER_EVENTS: readonly PowerEvent[] = ["suspend", "resume", "lock-screen", "unlock-screen"];

export interface ConnectivityPowerMonitor {
  on(event: PowerEvent, listener: () => void): unknown;
  removeListener(event: PowerEvent, listener: () => void): unknown;
}

export interface ConnectivitySignalDeps {
  readonly powerMonitor: ConnectivityPowerMonitor;
  readonly isOnline: () => boolean;
  readonly publish: (signal: DesktopConnectivitySignal) => void;
  readonly log: (message: string) => void;
  readonly platform: NodeJS.Platform;
  /** Runs once per resume, after the hint is published. */
  readonly onResume?: () => void;
  readonly now?: () => number;
  readonly setInterval?: (callback: () => void, ms: number) => { unref?: () => void };
  readonly clearInterval?: (handle: unknown) => void;
}

/** Documents which power events each platform can deliver, so a missing one is explainable. */
export function describeConnectivitySignalSupport(platform: NodeJS.Platform): string {
  if (platform === "darwin" || platform === "win32") {
    return "suspend, resume, lock-screen and unlock-screen are supported";
  }
  if (platform === "linux") {
    return "suspend and resume need a logind D-Bus session and lock-screen is unsupported; relying on resume plus the online poll and sleep-gap detection";
  }
  return "power events are unverified on this platform; relying on the online poll and sleep-gap detection";
}

/**
 * Publishes coalesced sleep, wake, lock and network hints from Electron main.
 * The online state is polled on a coarse interval and immediately after resume.
 */
export class DesktopConnectivitySignals {
  private sequence = 0;
  private online: boolean | null = null;
  private lastPublished = new Map<DesktopConnectivitySignalKind, number>();
  private lastTickAt = 0;
  private resumeSeenSinceTick = false;
  private timer: unknown = null;
  private readonly listeners = new Map<PowerEvent, () => void>();
  private readonly now: () => number;

  constructor(private readonly deps: ConnectivitySignalDeps) {
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    if (this.timer !== null) return;
    this.deps.log(
      `connectivity signals started platform=${this.deps.platform} support="${describeConnectivitySignalSupport(this.deps.platform)}"`,
    );
    for (const event of POWER_EVENTS) {
      const listener = () => this.handlePowerEvent(event);
      this.listeners.set(event, listener);
      try {
        this.deps.powerMonitor.on(event, listener);
      } catch (error) {
        this.deps.log(`connectivity signal unavailable event=${event} error=${String(error)}`);
      }
    }
    this.online = this.readOnline();
    this.lastTickAt = this.now();
    const schedule = this.deps.setInterval ?? ((callback, ms) => setInterval(callback, ms));
    const handle = schedule(() => this.tick(), CONNECTIVITY_ONLINE_POLL_MS);
    handle.unref?.();
    this.timer = handle;
  }

  stop(): void {
    if (this.timer === null) return;
    (this.deps.clearInterval ?? ((handle) => clearInterval(handle as NodeJS.Timeout)))(this.timer);
    this.timer = null;
    for (const [event, listener] of this.listeners) {
      this.deps.powerMonitor.removeListener(event, listener);
    }
    this.listeners.clear();
  }

  private handlePowerEvent(event: PowerEvent): void {
    if (event === "resume") {
      this.resumeSeenSinceTick = true;
      this.pollOnline();
      this.publish("resume");
      this.deps.onResume?.();
      return;
    }
    this.publish(event);
  }

  private tick(): void {
    const at = this.now();
    const gapMs = at - this.lastTickAt;
    this.lastTickAt = at;
    if (gapMs >= CONNECTIVITY_SLEEP_GAP_MS && !this.resumeSeenSinceTick) {
      // The OS slept without delivering `resume` (common on Linux without logind).
      this.deps.log(`connectivity resume signal missing; detected sleep gapMs=${gapMs}`);
      this.handlePowerEvent("resume");
    }
    this.resumeSeenSinceTick = false;
    this.pollOnline();
  }

  private pollOnline(): void {
    const online = this.readOnline();
    if (online === null || online === this.online) return;
    const previous = this.online;
    this.online = online;
    if (previous !== null) this.publish(online ? "online" : "offline");
  }

  private readOnline(): boolean | null {
    try {
      return this.deps.isOnline();
    } catch (error) {
      this.deps.log(`connectivity online probe failed error=${String(error)}`);
      return null;
    }
  }

  private publish(kind: DesktopConnectivitySignalKind): void {
    const at = this.now();
    const previous = this.lastPublished.get(kind);
    if (previous !== undefined && at - previous < CONNECTIVITY_COALESCE_MS) return;
    this.lastPublished.set(kind, at);
    this.sequence += 1;
    this.deps.log(`connectivity signal kind=${kind} sequence=${this.sequence}`);
    this.deps.publish({ kind, sequence: this.sequence, occurredAt: at, online: this.online });
  }
}
