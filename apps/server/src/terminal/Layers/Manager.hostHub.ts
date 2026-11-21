/**
 * Manager-wide wiring for host-backed terminals (plan S3): lifecycle notice fan-out, inventory
 * refresh when host facts change, policy pushes, view-state pushes (view reports, renderer
 * attach/detach, the 120 s lease expiry) and the host roster. Without a host runtime every hook
 * is inert, so in-process terminals behave exactly as before.
 *
 * @module Manager.hostHub
 */
import type { TerminalLifecycleNotice } from "@bigbud/contracts/workspace/terminal.lifecycle.ts";
import type { TerminalSessionInventory } from "@bigbud/contracts/workspace/terminal.stream.ts";
import * as Effect from "effect/Effect";

import type { TerminalViewRegistry } from "../activity/terminalViewRegistry.ts";
import type { OwnedPtyHostEvent, OwnedPtyRuntime } from "../Services/OwnedPtyRuntime.ts";
import type { TerminalHostHub } from "./Manager.host.types.ts";
import { legacyTerminalHostNotice, offlineClosedNotice } from "./Manager.hostInventory.ts";
import {
  applyTerminalHostNotice,
  terminalLifecycleNoticeFromHost,
} from "./Manager.hostLifecycle.ts";
import {
  pushTerminalHostViewState,
  TerminalHostPolicyPusher,
  terminalHostViewState,
  TerminalRendererRegistry,
} from "./Manager.hostPolicy.ts";
import { TerminalHostRoster } from "./Manager.hostRoster.ts";
import { toSessionKey } from "./Manager.shell";
import type { TerminalSessionState } from "./Manager.types.ts";

const INVENTORY_REFRESH_DELAY_MS = 250;
const MAX_STICKY_NOTICES = 16;
/** Roster, notice cursor and reconnect check while a host is admitted. */
export const TERMINAL_HOST_TICK_MS = 30_000;
/** Startup notices reach renderers that connect a little after the backend, then retire. */
const STICKY_NOTICE_TTL_MS = 120_000;

export interface TerminalHostHubDeps {
  readonly runtime: () => OwnedPtyRuntime | undefined;
  readonly keepRunningAfterQuit: () => boolean;
  readonly views: TerminalViewRegistry;
  /** Current sessions, read synchronously (no fiber per view report). */
  readonly sessions: () => Iterable<TerminalSessionState>;
  readonly inventory: () => Effect.Effect<TerminalSessionInventory>;
  readonly runFork: (effect: Effect.Effect<void>) => void;
  readonly log: (message: string, detail: Record<string, unknown>) => void;
  /** Settings changes (the keep setting changes the orphan policy). */
  readonly onSettingsChange?: (listener: () => void) => () => void;
}

export interface TerminalHostHubRuntime extends TerminalHostHub {
  readonly renderers: TerminalRendererRegistry;
  readonly roster: TerminalHostRoster;
  /** Adoption, roster, policy, old-host notices and host-wide events; never rejects. */
  readonly start: () => Promise<void>;
  readonly closeDrainingHosts: () => Promise<{ closed: number; remaining: number }>;
  readonly dispose: () => void;
}

export function makeTerminalHostHub(deps: TerminalHostHubDeps): TerminalHostHubRuntime {
  const lifecycleListeners = new Set<(notice: TerminalLifecycleNotice) => Effect.Effect<void>>();
  const inventoryListeners = new Set<
    (inventory: TerminalSessionInventory) => Effect.Effect<void>
  >();
  let sticky: Array<TerminalLifecycleNotice & { readonly expiresAt?: number }> = [];
  const renderers = new TerminalRendererRegistry();
  const roster = new TerminalHostRoster(deps.runtime, deps.log);
  const policy = new TerminalHostPolicyPusher(deps.runtime, deps.keepRunningAfterQuit, deps.log);
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let hostEventsKey: string | undefined;
  let unsubscribeHostEvents: (() => void) | undefined;
  let unsubscribeSettings: (() => void) | undefined;
  let tickTimer: ReturnType<typeof setInterval> | undefined;
  let tickKey: string | undefined;
  let ticking = false;
  let disposed = false;

  const publishNotice = (notice: TerminalLifecycleNotice) =>
    Effect.forEach([...lifecycleListeners], (listener) =>
      listener(notice).pipe(Effect.ignoreCause({ log: true })),
    ).pipe(Effect.asVoid);

  const refreshInventory = () => {
    if (disposed || refreshTimer || inventoryListeners.size === 0) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      deps.runFork(
        Effect.gen(function* () {
          const inventory = yield* deps.inventory();
          for (const listener of inventoryListeners)
            yield* listener(inventory).pipe(Effect.ignoreCause({ log: true }));
        }),
      );
    }, INVENTORY_REFRESH_DELAY_MS);
    refreshTimer.unref?.();
  };

  const pushView = (session: TerminalSessionState) => {
    const key = toSessionKey(session.threadId, session.terminalId);
    pushTerminalHostViewState(
      session,
      terminalHostViewState({
        visible: deps.views.isViewed(session.threadId, session.terminalId),
        renderers: renderers.count(key),
        ackedSequence: renderers.ackedSequence(key),
      }),
      deps.log,
    );
  };

  const pushViews = (match: (session: TerminalSessionState) => boolean) => {
    for (const session of deps.sessions()) if (session.host && match(session)) pushView(session);
  };

  const scheduleExpiry = () => {
    if (expiryTimer) clearTimeout(expiryTimer);
    expiryTimer = undefined;
    const next = deps.views.nextExpiryAt();
    if (disposed || next === undefined) return;
    expiryTimer = setTimeout(
      () => {
        expiryTimer = undefined;
        // A lapsed lease means hidden: re-evaluate every host pane (pushes are deduplicated).
        pushViews(() => true);
        scheduleExpiry();
      },
      Math.max(0, next - Date.now()) + 10,
    );
    expiryTimer.unref?.();
  };

  const unsubscribeViews = deps.views.subscribe((panes) => {
    const keys = new Set(panes.map((pane) => toSessionKey(pane.threadId, pane.terminalId)));
    pushViews((session) => keys.has(toSessionKey(session.threadId, session.terminalId)));
    scheduleExpiry();
  });

  /** Host-wide notices (no pane, or a pane no session holds yet) from the admitted host. */
  const onHostEvent = (event: OwnedPtyHostEvent) => {
    if (event.type !== "notice") return;
    // Every live notice, a session's own included, has now been seen by a backend.
    deps.runtime()?.hostGenerations?.recordSeenNotice(event.value.noticeId);
    deps.runFork(
      Effect.gen(function* () {
        const ptyId = event.value.ptyId;
        let owner: TerminalSessionState | undefined;
        for (const session of deps.sessions())
          if (ptyId && session.host?.ptyId === ptyId) owner = session;
        // A live process's own listener reports it; an ended one (its exit came first) is ours.
        if (owner?.process) return;
        const pane =
          owner ?? (ptyId ? roster.entries().find((entry) => entry.ptyId === ptyId) : undefined);
        const mapped = terminalLifecycleNoticeFromHost(event.value, pane);
        if (!mapped) return;
        if (owner?.host) applyTerminalHostNotice(owner, owner.host, mapped.notice, mapped.ended);
        if (mapped.ended) void roster.refresh().then(refreshInventory);
        yield* publishNotice(mapped.notice);
      }),
    );
  };

  const ensureHostEvents = async () => {
    const runtime = deps.runtime();
    const key = await runtime?.hostGenerations?.admittedKey().catch(() => undefined);
    if (!runtime?.host || key === hostEventsKey || disposed) return;
    unsubscribeHostEvents?.();
    unsubscribeHostEvents = undefined;
    hostEventsKey = key;
    if (key)
      unsubscribeHostEvents = await runtime.host.subscribe(onHostEvent).catch(() => undefined);
  };

  const ensureHost = () => {
    void policy.ensure();
    void ensureHostEvents();
  };

  const remember = (notice: TerminalLifecycleNotice, expiresAt?: number) => {
    if (sticky.some((entry) => entry.noticeId === notice.noticeId)) return false;
    sticky = [...sticky, { ...notice, ...(expiresAt ? { expiresAt } : {}) }].slice(
      -MAX_STICKY_NOTICES,
    );
    return true;
  };

  const refreshRoster = async () => {
    const before = JSON.stringify(roster.entries());
    await roster.refresh();
    if (JSON.stringify(roster.entries()) !== before) refreshInventory();
  };

  /** Keeps the roster and notice cursors current; a new admitted host is a reconnect. */
  const tick = async () => {
    const generations = deps.runtime()?.hostGenerations;
    if (!generations || ticking || disposed) return;
    ticking = true;
    try {
      const key = await generations.admittedKey().catch(() => undefined);
      if (!key) return;
      if (key !== tickKey) {
        tickKey = key;
        ensureHost();
      }
      await refreshRoster();
      // Advancing the cursors here means only notices from while no backend ran stay unseen.
      await generations.replayNotices().catch(() => []);
    } finally {
      ticking = false;
    }
  };

  const raiseOfflineSummary = async () => {
    const generations = deps.runtime()?.hostGenerations;
    if (!generations) return;
    const replays = await generations.replayNotices().catch(() => []);
    for (const replay of replays)
      if (replay.gap)
        deps.log("terminal host notices were evicted before replay; the summary is partial", {
          generation: replay.generation,
        });
    const notice = offlineClosedNotice(replays, new Date().toISOString());
    if (notice && remember(notice, Date.now() + STICKY_NOTICE_TTL_MS))
      deps.runFork(publishNotice(notice));
  };

  const raiseLegacyNotices = () => {
    const generations = deps.runtime()?.hostGenerations;
    if (!generations) return;
    const createdAt = new Date().toISOString();
    for (const notice of generations.drainingNotices().filter((entry) => entry.firstTime)) {
      const item = legacyTerminalHostNotice(notice, createdAt);
      if (remember(item)) deps.runFork(publishNotice(item));
    }
  };

  return {
    renderers,
    roster,
    publishNotice,
    refreshInventory,
    subscribeLifecycle: (listener) =>
      Effect.gen(function* () {
        lifecycleListeners.add(listener);
        // One-time startup toasts reach renderers that subscribe after adoption, too.
        const now = Date.now();
        sticky = sticky.filter((entry) => entry.expiresAt === undefined || entry.expiresAt > now);
        for (const { expiresAt: _expiresAt, ...notice } of sticky)
          yield* listener(notice).pipe(Effect.ignoreCause({ log: true }));
        return () => {
          lifecycleListeners.delete(listener);
        };
      }),
    registerInventoryListener: (listener) => {
      inventoryListeners.add(listener);
      return () => inventoryListeners.delete(listener);
    },
    sessionStarted: (threadId, terminalId) => {
      ensureHost();
      pushViews((session) => session.threadId === threadId && session.terminalId === terminalId);
      refreshInventory();
    },
    viewChanged: (threadId, terminalId) =>
      pushViews((session) => session.threadId === threadId && session.terminalId === terminalId),
    start: async () => {
      if (!deps.runtime()?.hostGenerations) return;
      await roster.ready();
      refreshInventory();
      raiseLegacyNotices();
      await raiseOfflineSummary();
      ensureHost();
      unsubscribeSettings ??= deps.onSettingsChange?.(ensureHost);
      tickKey = await deps
        .runtime()
        ?.hostGenerations?.admittedKey()
        .catch(() => undefined);
      if (!disposed && !tickTimer) {
        tickTimer = setInterval(() => void tick(), TERMINAL_HOST_TICK_MS);
        tickTimer.unref?.();
      }
    },
    closeDrainingHosts: async () => {
      const generations = deps.runtime()?.hostGenerations;
      if (!generations) return { closed: 0, remaining: 0 };
      const result = await generations.closeDrainingHosts();
      const open = new Set(
        generations.drainingNotices().map((notice) => `legacy-host:${notice.generation}`),
      );
      sticky = sticky.filter((notice) => open.has(notice.noticeId));
      return result;
    },
    dispose: () => {
      disposed = true;
      if (refreshTimer) clearTimeout(refreshTimer);
      if (expiryTimer) clearTimeout(expiryTimer);
      if (tickTimer) clearInterval(tickTimer);
      unsubscribeViews();
      unsubscribeHostEvents?.();
      unsubscribeSettings?.();
      lifecycleListeners.clear();
      inventoryListeners.clear();
    },
  };
}
