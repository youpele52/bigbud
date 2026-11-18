import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
  MOBILE_GATEWAY_POLICY,
  mobileGatewayCommand,
  type MobileGatewayLaunch,
  type MobileGatewayDependencies,
  type MobileGatewayStatus,
} from "./mobileGatewaySupervisor.config.ts";

type Child = ChildProcessWithoutNullStreams;

/** One owned transport child; the caller supplies consent, verified artifacts and lifetime. */
export class MobileGatewaySupervisor {
  private child: Child | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private pending: Promise<void> | null = null;
  private crashTimes: number[] = [];
  private stopped = true;
  private state: MobileGatewayStatus = "stopped";
  private stopping: Promise<void> | null = null;
  private readonly config: MobileGatewayLaunch;
  private readonly deps: MobileGatewayDependencies;
  private startGuard: () => boolean = () => true;

  constructor(config: MobileGatewayLaunch, deps: MobileGatewayDependencies = {}) {
    this.config = Object.freeze({ ...config, upstream: Object.freeze({ ...config.upstream }) });
    this.deps = Object.freeze({ ...deps });
  }

  getStatus() {
    return this.state;
  }
  private publish(status: MobileGatewayStatus) {
    this.state = status;
    this.deps.onStatus?.(status);
  }

  async start(allowed?: () => boolean): Promise<void> {
    if (this.stopping) await this.stopping;
    if (allowed !== undefined) this.startGuard = allowed;
    if (!this.startGuard() || this.deps.allowed?.() === false)
      throw new Error("Mobile gateway owner cannot start.");
    if (this.state === "ready") return;
    if (this.state === "needs-repair") throw new Error("Mobile gateway needs repair.");
    if (this.pending) return this.pending;
    if (this.restartTimer) throw new Error("Mobile gateway is retrying.");
    if (this.child) throw new Error("Mobile gateway exit was not confirmed.");
    this.stopped = false;
    this.pending = this.launch();
    try {
      await this.pending;
    } finally {
      this.pending = null;
    }
  }

  /** Only an explicit user recovery resets a spent crash budget. */
  async retry(allowed?: () => boolean): Promise<void> {
    await this.stop();
    this.crashTimes = [];
    return this.start(allowed);
  }

  private scheduleRestart() {
    if (this.stopped || this.restartTimer) return;
    if (this.deps.autoRestart === false) {
      this.publish("needs-repair");
      return;
    }
    const now = (this.deps.now ?? Date.now)();
    this.crashTimes = this.crashTimes.filter(
      (time) => now - time < MOBILE_GATEWAY_POLICY.crashWindowMs,
    );
    if (this.crashTimes.length >= MOBILE_GATEWAY_POLICY.maxCrashRestarts) {
      this.publish("needs-repair");
      return;
    }
    this.crashTimes.push(now);
    this.publish("retrying");
    this.restartTimer = setTimeout(
      () => {
        this.restartTimer = null;
        void this.start().catch(() => {
          /* status is published; never restart the backend */
        });
      },
      MOBILE_GATEWAY_POLICY.retryBaseMs * 2 ** (this.crashTimes.length - 1),
    );
    this.restartTimer.unref();
  }

  private launch(): Promise<void> {
    this.publish("starting");
    const { binary, port } = this.config;
    let command: ReturnType<typeof mobileGatewayCommand>;
    try {
      command = mobileGatewayCommand(this.config);
    } catch {
      this.publish("needs-repair");
      return Promise.reject(new Error("Invalid mobile gateway configuration."));
    }
    let child: Child;
    try {
      child = (this.deps.spawn ?? spawn)(binary, command.args, {
        env: command.env,
        stdio: "pipe",
        windowsHide: true,
      }) as Child;
    } catch {
      this.scheduleRestart();
      return Promise.reject(new Error("Mobile gateway could not start."));
    }
    this.child = child;
    // Drain but do not expose stderr: OS/provider errors can echo credentials or paths.
    child.stderr.resume();
    child.stdin.on("error", () => undefined);
    return new Promise((resolve, reject) => {
      let settled = false;
      let failed = false;
      let buffer = "";
      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve();
      };
      const fail = () => {
        if (failed || this.child !== child) return;
        failed = true;
        this.publish("needs-repair");
        settle(new Error("Mobile gateway stopped before it was available."));
        // Reap before retrying; never let an unconfirmed live child overlap another bind.
        child.stdin.end();
        child.kill("SIGKILL");
      };
      const timeout = setTimeout(fail, MOBILE_GATEWAY_POLICY.readinessMs);
      timeout.unref();
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (this.child !== child || failed || settled || this.stopped) return;
        buffer += chunk;
        if (Buffer.byteLength(buffer) > MOBILE_GATEWAY_POLICY.maxReadyBytes) return fail();
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        try {
          const record = JSON.parse(buffer.slice(0, newline));
          if (record.event !== "ready" || record.listen !== `127.0.0.1:${port}`) return fail();
          this.publish("ready");
          settle();
        } catch {
          fail();
        }
      });
      child.on("error", fail);
      child.once("close", () => {
        settle(new Error("Mobile gateway stopped before it was available."));
        if (this.child !== child) return;
        this.child = null;
        this.scheduleRestart();
      });
    });
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopped = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const child = this.child;
    this.publish("stopped");
    if (!child) return Promise.resolve();
    this.stopping = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("Mobile gateway exit was not confirmed."));
      }, MOBILE_GATEWAY_POLICY.shutdownMs);
      timer.unref();
      child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      child.stdin.end();
    }).finally(() => {
      this.stopping = null;
    });
    return this.stopping;
  }
}
