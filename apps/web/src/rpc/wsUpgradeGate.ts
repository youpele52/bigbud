/** Upgrade attempts may stay pending this long while a frozen server catches up. */
export const WS_OPEN_TIMEOUT_MS = 30_000;
/** Liveness bound in case a browser never reports the abandoned attempt's close. */
export const WS_UPGRADE_SETTLE_GRACE_MS = 5_000;

interface PendingUpgrade {
  readonly settled: Promise<void>;
  readonly deadlineAt: number;
}

interface UpgradeSocket {
  addEventListener(type: "open" | "close", listener: () => void, options?: object): void;
}

/**
 * Storm guard: keeps at most one in-flight WebSocket upgrade per transport. A new socket is
 * only created once the previous attempt has opened or closed, so a frozen server sees one
 * pending upgrade instead of one per retry.
 */
export class WsUpgradeGate {
  private pending: PendingUpgrade | null = null;

  constructor(
    private readonly settleBoundMs = WS_OPEN_TIMEOUT_MS + WS_UPGRADE_SETTLE_GRACE_MS,
    private readonly now: () => number = Date.now,
  ) {}

  get hasPendingUpgrade(): boolean {
    return this.pending !== null;
  }

  track(socket: UpgradeSocket): void {
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const entry: PendingUpgrade = { settled, deadlineAt: this.now() + this.settleBoundMs };
    this.pending = entry;
    const finish = () => {
      if (this.pending === entry) this.pending = null;
      settle();
    };
    socket.addEventListener("open", finish, { once: true });
    // "error" is always followed by "close", so the attempt is settled only once it closes.
    socket.addEventListener("close", finish, { once: true });
  }

  /** Resolves once no upgrade is pending, bounded so a lost close event cannot wedge retries. */
  async whenSettled(): Promise<void> {
    for (;;) {
      const entry = this.pending;
      if (!entry) return;
      const remainingMs = entry.deadlineAt - this.now();
      if (remainingMs <= 0) {
        console.warn("WebSocket upgrade never settled; allowing a replacement attempt.");
        if (this.pending === entry) this.pending = null;
        return;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        entry.settled,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, remainingMs);
        }),
      ]);
      clearTimeout(timer);
    }
  }
}
