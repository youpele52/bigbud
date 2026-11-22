/**
 * Remote-agent terminal hosts (plan §7.2, §8.7, §14). Each remote host runs its own Rust
 * lifecycle, so the server drives it like the local host, but per remote connection: it pushes
 * the host policy on every new connection and keep-setting change, listens for host-wide notices
 * (a close notice follows the PTY's exit, after the session stopped listening), and closes the
 * managed terminals on a default-mode quit. Hosts are found through the running managed sessions
 * whose PTY exposes host-wide controls (remote agents that advertise protocol 1.9 lifecycle
 * only); an older agent never has them, and the local host never goes through here.
 *
 * @module Manager.remoteHosts
 */
import type { PtyHostWideControl } from "../Services/PTY.ts";
import type { OwnedPtyHostEvent } from "../Services/OwnedPtyRuntime.ts";
import { terminalHostPolicy } from "./Manager.hostPolicy.ts";
import type { TerminalSessionState } from "./Manager.types.ts";

/** How often the connections are re-checked (a reconnect needs the policy again). */
export const TERMINAL_REMOTE_HOST_TICK_MS = 30_000;
/** Bound on remembered connections (one per remote host and reconnect). */
const MAX_REMOTE_CONNECTIONS = 64;

export interface TerminalRemoteHostsDeps {
  readonly sessions: () => Iterable<TerminalSessionState>;
  readonly keepRunningAfterQuit: () => boolean;
  /** Host-wide events of one remote connection (notices of ended sessions). */
  readonly onHostEvent: (event: OwnedPtyHostEvent) => void;
  readonly log: (message: string, detail: Record<string, unknown>) => void;
  readonly now?: () => number;
}

interface RemoteConnection {
  /** `keep` or `close`: the orphan policy last confirmed on this connection. */
  pushed: string | undefined;
  unsubscribe: (() => void) | undefined;
}

/** One control per remote connection that carries a running managed terminal. */
export function remoteTerminalHostControls(
  sessions: Iterable<TerminalSessionState>,
): Map<string, PtyHostWideControl> {
  const controls = new Map<string, PtyHostWideControl>();
  for (const session of sessions) {
    const hostWide = session.process?.lifecycle?.hostWide;
    if (!hostWide || !session.host?.lifecycle || session.status !== "running") continue;
    try {
      controls.set(hostWide.connectionKey(), hostWide);
    } catch {
      // A PTY between connections has no host to address right now.
    }
  }
  return controls;
}

export class TerminalRemoteHosts {
  private readonly connections = new Map<string, RemoteConnection>();
  private running: Promise<void> | undefined;
  private again = false;
  private revision = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private disposed = false;

  constructor(private readonly deps: TerminalRemoteHostsDeps) {}

  /** Coalesced: policy and event subscription for every new connection or keep change. */
  ensure(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.run().finally(() => {
      this.running = undefined;
      if (this.again) {
        this.again = false;
        void this.ensure();
      }
    });
    return this.running;
  }

  /** True while any running managed terminal lives on a remote host. */
  hasHosts(): boolean {
    return remoteTerminalHostControls(this.deps.sessions()).size > 0;
  }

  /**
   * Default-mode quit: `PtyCloseAll(managed_only)` on every remote connection at once, bounded by
   * `signal`. An unconfirmed host keeps its terminals until its orphan timer closes them.
   */
  async closeAll(
    input: { readonly reason: "quit" | "update"; readonly managedOnly: boolean },
    signal?: AbortSignal,
  ): Promise<{ readonly closed: number; readonly unreachable: number }> {
    const controls = [...remoteTerminalHostControls(this.deps.sessions()).values()];
    const results = await Promise.allSettled(
      controls.map((control) => control.closeAll(input, signal)),
    );
    let closed = 0;
    let unreachable = 0;
    for (const result of results) {
      if (result.status === "fulfilled") closed += result.value;
      else {
        unreachable += 1;
        this.deps.log(
          "a remote terminal host did not confirm close-all; its orphan timer applies",
          {
            cause: String(result.reason),
          },
        );
      }
    }
    return { closed, unreachable };
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const connection of this.connections.values()) connection.unsubscribe?.();
    this.connections.clear();
  }

  private async run(): Promise<void> {
    const controls = remoteTerminalHostControls(this.deps.sessions());
    if (controls.size === 0) return;
    this.startTicking();
    const policyKey = this.deps.keepRunningAfterQuit() ? "keep" : "close";
    await Promise.all(
      [...controls].map(async ([key, control]) => {
        const connection = this.remember(key);
        if (!connection.unsubscribe)
          connection.unsubscribe = await control
            .subscribe((event) => this.deps.onHostEvent(event))
            .catch(() => undefined);
        if (connection.pushed === policyKey) return;
        this.revision = Math.max(this.revision + 1, (this.deps.now ?? Date.now)());
        try {
          await control.updatePolicy(
            terminalHostPolicy({
              keepRunningAfterQuit: policyKey === "keep",
              revision: this.revision,
            }),
          );
          connection.pushed = policyKey;
        } catch (cause) {
          this.deps.log("remote terminal host policy push failed", { cause: String(cause) });
        }
      }),
    );
  }

  private remember(key: string): RemoteConnection {
    let connection = this.connections.get(key);
    if (connection) return connection;
    connection = { pushed: undefined, unsubscribe: undefined };
    this.connections.set(key, connection);
    if (this.connections.size > MAX_REMOTE_CONNECTIONS) {
      const [oldestKey, oldest] = this.connections.entries().next().value!;
      oldest.unsubscribe?.();
      this.connections.delete(oldestKey);
    }
    return connection;
  }

  private startTicking(): void {
    if (this.timer || this.disposed) return;
    this.timer = setInterval(() => void this.ensure(), TERMINAL_REMOTE_HOST_TICK_MS);
    this.timer.unref?.();
  }
}
