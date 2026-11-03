import type {
  MonitorDemand,
  MonitorEvent,
  MonitorProcessPage,
  MonitorProcessQuery,
  MonitorSnapshot,
} from "@bigbud/contracts/system-monitor/types";
import type {
  ResourceAlert,
  ResourceAwarenessState,
} from "@bigbud/contracts/system-monitor/awareness.ts";
import { ResourceRuleEvaluator } from "@bigbud/shared/resourceAwareness.rules";
import type { SystemMonitorBridge } from "./bridge";
import { ResourcePreferencesStore } from "./awareness.preferences";

/** Desktop-owned subscription; UI visibility and AI turns never own its lifetime. */
export class ResourceAwareness {
  readonly preferences: ResourcePreferencesStore;
  snapshot: MonitorSnapshot | undefined;
  history: MonitorSnapshot[] = [];
  private evaluator = new ResourceRuleEvaluator();
  private id: number | undefined;
  private demand: MonitorDemand | undefined;
  private stopped = false;
  private starting: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private attempt = 0;
  private retryAt = 0;
  private needsRetry = false;
  private subscribedAt = 0;
  private acknowledged = new Set<string>();
  private processUntil = 0;
  private leases = 0;
  private publicationSequence = 0;
  private dispose: (() => void) | undefined;
  private health: ResourceAwarenessState["health"] = "warming";
  private listeners = new Set<(state: ResourceAwarenessState, events: ResourceAlert[]) => void>();
  private waiters = new Map<() => void, () => void>();

  constructor(
    private readonly bridge: SystemMonitorBridge,
    path: string,
  ) {
    this.preferences = new ResourcePreferencesStore(path);
  }

  async start(): Promise<void> {
    await this.preferences.load();
    if (this.stopped) return;
    this.evaluator = new ResourceRuleEvaluator(this.preferences.cooldowns);
    this.dispose = this.bridge.onEventInternal((event) => this.onEvent(event));
    await this.ensure();
  }

  state(): ResourceAwarenessState {
    const stale = !this.snapshot || Date.now() - this.snapshot.sampledAtMs > 5000;
    return {
      stateSequence: this.publicationSequence,
      preferences: this.preferences.value,
      appStatus: this.bridge.appResourceStatus(),
      alertsTruncated: this.evaluator.isTruncated(),
      health: !this.preferences.value.enabled ? "disabled" : stale ? "unavailable" : this.health,
      ...(this.preferences.diagnostic ? { diagnostic: this.preferences.diagnostic } : {}),
      ...(this.snapshot ? { sampledAtMs: this.snapshot.sampledAtMs } : {}),
      alerts: this.evaluator.alerts().map((alert) =>
        Object.assign({}, alert, {
          state: stale ? "unknown" : alert.state,
          acknowledged: this.acknowledged.has(alert.id),
        }),
      ),
    };
  }

  listen(listener: (state: ResourceAwarenessState, events: ResourceAlert[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private publish(events: ResourceAlert[] = []): void {
    this.publicationSequence++;
    const state = this.state();
    for (const listener of this.listeners) listener(state, events);
    for (const waiter of this.waiters.keys()) waiter();
  }

  acknowledge(ids: string[]): void {
    const active = new Set(this.evaluator.alerts().map((alert) => alert.id));
    for (const id of ids.slice(0, 64)) if (active.has(id)) this.acknowledged.add(id);
    while (this.acknowledged.size > 256)
      this.acknowledged.delete(this.acknowledged.values().next().value!);
    this.publish();
  }

  private schedule(delay: number): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.ensure();
    }, delay);
    this.timer.unref();
  }

  private ensure(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.starting) return this.starting;
    if (this.id === undefined && Date.now() < this.retryAt) return Promise.resolve();
    this.starting = this.renew()
      .catch(() => {
        this.release();
        this.evaluator.reset();
        this.health = "unavailable";
        this.publish();
        this.backoff();
      })
      .finally(() => {
        this.starting = undefined;
      });
    return this.starting;
  }

  private async renew(): Promise<void> {
    if (!this.preferences.value.enabled && this.leases === 0 && Date.now() >= this.processUntil) {
      this.release();
      this.health = "disabled";
      this.publish();
      return;
    }
    if (
      this.id !== undefined &&
      Date.now() - Math.max(this.subscribedAt, this.snapshot?.sampledAtMs ?? 0) > 10000
    ) {
      this.release();
      this.evaluator.reset();
      this.health = "unavailable";
    }
    if (this.needsRetry) {
      await this.bridge.retry();
      this.needsRetry = false;
    }
    const demand = await this.bridge.awarenessDemand(Date.now() < this.processUntil);
    if (this.stopped) return;
    if (this.id === undefined) {
      const id = await this.bridge.subscribe(demand);
      if (this.stopped) {
        this.bridge.unsubscribe(id);
        return;
      }
      this.id = id;
      this.subscribedAt = Date.now();
      this.demand = demand;
      const early = this.bridge.takeEarlySnapshot(id);
      if (early) this.accept(early);
    } else {
      this.bridge.update(this.id, demand);
      this.demand = demand;
    }
    this.schedule(5000);
  }

  private onEvent(event: MonitorEvent): void {
    if (
      event.type === "error" &&
      event.error.subscriptionId === this.id &&
      event.error.code === "unknown-subscription"
    ) {
      this.release();
      this.evaluator.reset();
      this.health = "unavailable";
      this.backoff();
      this.publish();
      return;
    }
    if (event.type === "snapshot" && event.snapshot.subscriptionId === this.id)
      this.accept(event.snapshot);
    else if (
      event.type === "unavailable" ||
      (event.type === "collectionStatus" && event.status.state !== "healthy")
    ) {
      this.evaluator.reset();
      this.health = "unavailable";
      if (event.type === "unavailable") {
        this.id = undefined;
        this.needsRetry = false;
        this.backoff();
      } else if (event.status.state === "failed") {
        this.needsRetry = true;
        this.release();
        this.backoff();
      }
      this.publish();
    }
  }

  private accept(snapshot: MonitorSnapshot): void {
    // ACK before evaluation/persistence/UI work, including warming and duplicate samples.
    try {
      this.bridge.ack(snapshot.subscriptionId, snapshot.epoch, snapshot.sequence);
    } catch {
      return;
    }
    this.bridge.takeEarlySnapshot(snapshot.subscriptionId);
    if (
      this.snapshot?.epoch === snapshot.epoch &&
      this.snapshot.subscriptionId === snapshot.subscriptionId &&
      this.snapshot.sequence >= snapshot.sequence
    )
      return;
    if (this.snapshot?.epoch !== snapshot.epoch || snapshot.baseline) this.history = [];
    this.snapshot = snapshot;
    this.history.push({
      ...snapshot,
      perCorePercent: [],
      interfaces: [],
      disks: snapshot.disks.slice(0, 16),
      temperaturesCelsius: snapshot.temperaturesCelsius.slice(0, 16),
      ...(snapshot.criticalTemperaturesCelsius
        ? { criticalTemperaturesCelsius: snapshot.criticalTemperaturesCelsius.slice(0, 16) }
        : {}),
    });
    if (this.history.length > 300) this.history.shift();
    this.health = snapshot.summaryStatus === "ready" && !snapshot.baseline ? "healthy" : "warming";
    this.attempt = 0;
    this.retryAt = 0;
    const events = this.evaluator.evaluate(snapshot, this.preferences.value, Date.now());
    if (events.length)
      void this.preferences.saveCooldowns(this.evaluator.persistedCooldowns()).catch(() => {
        this.preferences.diagnostic = "Alert cooldown could not be saved.";
      });
    this.publish(events);
  }

  async mutate(raw: unknown, authorized?: () => boolean): Promise<ResourceAwarenessState> {
    await this.preferences.mutate(raw, () => !this.stopped && (authorized?.() ?? true));
    this.evaluator.reset();
    this.publish();
    await this.ensure();
    return this.state();
  }

  private waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
    if (this.stopped) return Promise.reject(new Error("monitor stopped"));
    if (predicate()) return Promise.resolve();
    if (this.waiters.size >= 8) return Promise.reject(new Error("monitor busy"));
    return new Promise((resolve, reject) => {
      const done = () => {
        if (!predicate()) return;
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(() => {
        this.waiters.delete(done);
        reject(new Error("monitor timeout"));
      }, timeoutMs);
      this.waiters.set(done, () => {
        clearTimeout(timer);
        reject(new Error("monitor stopped"));
      });
    });
  }

  async readSnapshot(cacheOnly = false): Promise<MonitorSnapshot> {
    const fresh = () =>
      !!this.snapshot &&
      Date.now() - this.snapshot.sampledAtMs <= 5000 &&
      this.snapshot.sampledAtMs <= Date.now() + 2000 &&
      this.health !== "unavailable";
    if (cacheOnly) {
      if (!this.preferences.value.enabled) throw new Error("monitoring disabled");
      if (!fresh()) throw new Error("desktop monitor unavailable");
      return this.snapshot!;
    }
    this.leases++;
    try {
      await this.ensure();
      await this.waitFor(fresh, 4000);
      return this.snapshot!;
    } finally {
      this.leases--;
      if (!this.preferences.value.enabled) this.schedule(1);
    }
  }

  async query(query: MonitorProcessQuery): Promise<MonitorProcessPage> {
    const since = Date.now();
    const alreadyCollecting = this.demand?.processes === true;
    this.processUntil = since + 15000;
    this.leases++;
    try {
      await this.ensure();
      // A renewal racing an earlier renewal gets a second pass before waiting.
      if (!this.demand?.processes) await this.ensure();
      await this.waitFor(
        () =>
          !!this.snapshot &&
          this.snapshot.processStatus === "ready" &&
          this.snapshot.sampledAtMs >= (alreadyCollecting ? since - 5000 : since),
        4000,
      );
      return await this.bridge.query(query);
    } finally {
      this.leases--;
    }
  }

  private release(): void {
    if (this.id !== undefined) {
      try {
        this.bridge.unsubscribe(this.id);
      } catch {
        /* child already gone */
      }
    }
    this.id = undefined;
    this.demand = undefined;
  }

  private backoff(): void {
    const delay = Math.min(30000, 1000 * 2 ** Math.min(this.attempt++, 5));
    this.retryAt = Date.now() + delay;
    this.schedule(delay);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.dispose?.();
    this.release();
    this.listeners.clear();
    for (const cancel of this.waiters.values()) cancel();
    this.waiters.clear();
    this.history = [];
    this.snapshot = undefined;
  }
}
