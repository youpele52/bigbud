import type { Terminal, ITerminalAddon, IDisposable } from "@xterm/xterm";
import type { TerminalGpuAcceleration } from "@bigbud/contracts/core/settings.ts";
import type { TerminalRenderingPolicy } from "@bigbud/contracts/server/ipc.terminal";
import {
  TerminalRendererBudget,
  terminalRendererBudget,
} from "./TerminalRendererController.policy";

export interface TerminalWebglAddon extends ITerminalAddon {
  onContextLoss: (listener: () => void) => IDisposable;
}
export interface TerminalRendererState {
  mode: "dom" | "webgl";
  reason: string | null;
}
const loadWebgl = async (): Promise<() => TerminalWebglAddon> => {
  const { WebglAddon } = await import("@xterm/addon-webgl");
  return () => new WebglAddon();
};

/** Owns only rendering resources. Never resets xterm, replays output or touches a PTY. */
export class TerminalRendererController {
  private addon: TerminalWebglAddon | undefined;
  private listener: IDisposable | undefined;
  private release: (() => void) | undefined;
  private unretain: (() => void) | undefined;
  private generation = 0;
  private disposed = false;
  private loading = false;
  private losses: number[] = [];
  private lastFailure = -Infinity;
  private latched = false;
  private state: TerminalRendererState = { mode: "dom", reason: null };
  private request:
    | { setting: TerminalGpuAcceleration; visible: boolean; policy: TerminalRenderingPolicy | null }
    | undefined;

  constructor(
    private readonly terminal: Pick<Terminal, "loadAddon" | "refresh" | "rows">,
    private readonly onState: (state: TerminalRendererState) => void,
    private readonly load: () => Promise<() => TerminalWebglAddon> = loadWebgl,
    private readonly budget: TerminalRendererBudget = terminalRendererBudget,
    private readonly now: () => number = () => performance.now(),
  ) {}

  update(
    setting: TerminalGpuAcceleration,
    visible: boolean,
    policy: TerminalRenderingPolicy | null,
  ): void {
    const previous = this.request;
    this.request = { setting, visible, policy };
    if (setting === "off") {
      this.fallback(null);
      return;
    }
    if (!visible) {
      // An attached context is parked for a quick return; a pending attach is abandoned.
      if (this.addon && !this.loading) this.retain();
      else this.fallback("Hidden terminal uses DOM.");
      return;
    }
    if (!policy?.allowed) {
      this.fallback(policy?.reason ?? "Awaiting application rendering policy.");
      return;
    }
    if (this.unretain) {
      this.resume();
      return;
    }
    const changed =
      !previous || previous.setting !== setting || !previous.visible || !previous.policy?.allowed;
    if (changed && !this.addon && !this.loading) void this.attempt(false);
  }

  private retain(): void {
    if (this.unretain) return;
    this.release?.();
    this.release = undefined;
    this.unretain = this.budget.retain(() => {
      this.unretain = undefined;
      this.fallback("Hidden GPU context released for other terminals; terminal uses DOM.");
    });
  }

  private resume(): void {
    this.unretain?.();
    this.unretain = undefined;
    const release = this.budget.reserve();
    if (!release) {
      this.fallback("Visible GPU context budget exhausted.");
      return;
    }
    this.release = release;
  }

  /** Glyph shaping changed (ligatures): WebGL must rebuild its atlas on a fresh attachment. */
  reattach(): void {
    if (!this.addon || this.loading) return;
    if (!this.request?.visible) {
      this.fallback("Hidden terminal uses DOM.");
      return;
    }
    this.fallback(null);
    void this.attempt(true);
  }

  retry(): void {
    if (!this.addon && !this.loading) void this.attempt(true);
  }

  private async attempt(deliberate: boolean): Promise<void> {
    const request = this.request;
    if (this.disposed || !request?.visible || !request.policy?.allowed || request.setting === "off")
      return;
    if (
      !deliberate &&
      (this.latched || this.budget.isLatched || this.now() - this.lastFailure < 5000)
    ) {
      this.report(
        "dom",
        "GPU retry is cooling down or crash-latched; use Retry GPU for one explicit attempt.",
      );
      return;
    }
    const release = this.budget.reserve();
    if (!release) {
      this.report("dom", "Visible GPU context budget exhausted.");
      return;
    }
    this.release = release;
    this.loading = true;
    const generation = ++this.generation;
    let addon: TerminalWebglAddon | undefined;
    try {
      const createAddon = await this.load();
      if (this.disposed || generation !== this.generation) return;
      addon = createAddon();
      this.addon = addon;
      this.listener = addon.onContextLoss(() => {
        if (this.disposed || generation !== this.generation) return;
        const now = this.now();
        this.losses = this.losses.filter((time) => now - time < 60_000);
        this.losses.push(now);
        this.latched ||= this.losses.length >= 3;
        this.budget.loss(now);
        this.lastFailure = now;
        this.fallback("WebGL context lost; terminal preserved in DOM.");
      });
      if (generation !== this.generation || this.disposed) return;
      this.terminal.loadAddon(addon);
      if (generation === this.generation && !this.disposed) this.report("webgl", null);
    } catch {
      if (generation === this.generation && !this.disposed) {
        this.lastFailure = this.now();
        this.latched = true;
        this.fallback("WebGL attachment failed; terminal preserved in DOM.");
      }
    } finally {
      if (generation !== this.generation || this.disposed || !this.addon) release();
      if (generation === this.generation && !this.disposed) {
        this.loading = false;
        if (!this.addon) this.release = undefined;
      }
    }
  }

  private disposeAddon(addon: TerminalWebglAddon): void {
    try {
      addon.dispose();
    } catch {
      /* DOM still remains available. */
    }
  }
  private report(mode: "dom" | "webgl", reason: string | null): void {
    if (this.disposed || (this.state.mode === mode && this.state.reason === reason)) return;
    this.state = { mode, reason };
    try {
      this.onState(this.state);
    } catch {
      /* Contain application status callbacks. */
    }
  }
  private fallback(reason: string | null): void {
    this.generation++;
    this.loading = false;
    const addon = this.addon;
    this.addon = undefined;
    try {
      this.listener?.dispose();
    } catch {
      /* Contain partial-addon disposal. */
    }
    this.listener = undefined;
    if (addon) this.disposeAddon(addon);
    this.release?.();
    this.release = undefined;
    this.unretain?.();
    this.unretain = undefined;
    if (addon && !this.disposed) {
      try {
        this.terminal.refresh(0, this.terminal.rows - 1);
      } catch {
        /* A failed refresh never restarts the PTY. */
      }
    }
    this.report("dom", reason);
  }
  dispose(): void {
    this.disposed = true;
    this.fallback(null);
  }
}
