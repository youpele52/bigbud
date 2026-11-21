import type { TerminalContextSelection } from "~/lib/terminalContext";
import type {
  TerminalViewportProps,
  TerminalViewportSurfaceProps,
} from "../TerminalViewport.types";
import { recordTerminalViewRegistryEvent } from "../TerminalLifecycleDiagnostics";
import {
  createTerminalViewHost,
  freezeTerminalViewHostSize,
  isTerminalViewSlotInert,
  isTerminalViewSlotOnScreen,
  moveTerminalViewHost,
  releaseTerminalViewHostSize,
} from "./TerminalViewRegistry.dom";
import {
  nextTerminalViewParkCheck,
  selectTerminalViewsToEvict,
  selectTerminalViewsToPark,
  terminalViewState,
  type TerminalViewPolicyEntry,
  type TerminalViewState,
} from "./TerminalViewRegistry.policy";

const MAX_REPORTED_VIEWS = 16;

interface Borrower {
  readonly id: number;
  readonly slot: HTMLElement;
  props: TerminalViewportProps;
}

interface Entry extends TerminalViewPolicyEntry {
  readonly key: string;
  readonly threadId: string;
  readonly terminalId: string;
  readonly host: HTMLDivElement;
  borrowers: Borrower[];
  lastProps: TerminalViewportProps;
  render: TerminalViewportSurfaceProps;
  attached: boolean;
  mounted: boolean;
  restorable: boolean;
  lastAttachedAt: number;
  releasedAt: number | null;
  readonly callbacks: Pick<
    TerminalViewportSurfaceProps,
    "onSessionExited" | "onAddTerminalContext" | "onRestorableChange"
  >;
  readonly listeners: Set<() => void>;
}

export interface TerminalViewBorrow {
  update(props: TerminalViewportProps): void;
  release(): void;
}

export interface TerminalViewRegistryClock {
  readonly now: () => number;
  readonly setTimeout: (callback: () => void, delay: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
}

const defaultClock: TerminalViewRegistryClock = {
  now: () => Date.now(),
  setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function terminalViewKey(threadId: string, terminalId: string): string {
  return JSON.stringify([threadId, terminalId]);
}

function activeBorrower(entry: Entry): Borrower | undefined {
  for (let index = entry.borrowers.length - 1; index >= 0; index--) {
    const borrower = entry.borrowers[index]!;
    if (!isTerminalViewSlotInert(borrower.slot)) return borrower;
  }
  return entry.borrowers.at(-1);
}

function shallowEqual(left: object, right: object): boolean {
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  return leftKeys.every((key) =>
    Object.is((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]),
  );
}

/**
 * Owns every xterm view outside route and project gates. A borrower (a pane slot in a drawer or
 * the right panel) acquires a view and the registry moves the view's host element into its slot;
 * releasing moves it to the parking holder, where it keeps running hidden until the policy parks
 * (unmounts) it. Only restorable views are ever parked; they rebuild from the host's screen.
 */
export class TerminalViewRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly listListeners = new Set<() => void>();
  private readonly changeListeners = new Set<() => void>();
  private readonly hostListeners = new Set<() => void>();
  private mountedList: ReadonlyArray<Entry> = [];
  private holder: HTMLElement | null = null;
  private hostRendered = false;
  private nextBorrowerId = 0;
  private parkTimer: unknown = null;
  private isListed: (threadId: string, terminalId: string) => boolean = () => true;

  constructor(private readonly clock: TerminalViewRegistryClock = defaultClock) {}

  /**
   * Called while the parking host renders (idempotent, no notification), so borrowers rendered
   * after it in the same pass mount through the registry instead of inline.
   */
  markHostRendered(): void {
    this.hostRendered = true;
  }

  isHostAvailable = (): boolean => this.hostRendered;

  subscribeHost = (listener: () => void): (() => void) => this.listen(this.hostListeners, listener);

  attachHolder(holder: HTMLElement): () => void {
    this.holder = holder;
    this.hostRendered = true;
    for (const entry of this.entries.values())
      if (!entry.attached) moveTerminalViewHost(holder, entry.host);
    this.emit(this.hostListeners);
    return () => {
      if (this.holder !== holder) return;
      this.holder = null;
      this.hostRendered = false;
      this.emit(this.hostListeners);
      // The app tree is going away: its views must not reappear in the next host. Deferred so
      // StrictMode's synchronous effect replay (detach, re-attach) keeps every view.
      queueMicrotask(() => {
        if (this.holder === null) this.disposeAll();
      });
    };
  }

  /** Released views whose pane no longer exists are disposed instead of kept or parked. */
  setListedPredicate(isListed: (threadId: string, terminalId: string) => boolean): void {
    this.isListed = isListed;
    this.prune();
  }

  subscribe = (listener: () => void): (() => void) => this.listen(this.listListeners, listener);

  /** Mounted (attached or warm) views, in creation order; stable until the set changes. */
  getMountedEntries = (): ReadonlyArray<{ readonly key: string; readonly host: HTMLElement }> =>
    this.mountedList;

  subscribeChanges = (listener: () => void): (() => void) =>
    this.listen(this.changeListeners, listener);

  subscribeEntry(key: string, listener: () => void): () => void {
    const entry = this.entries.get(key);
    if (!entry) return () => undefined;
    entry.listeners.add(listener);
    return () => entry.listeners.delete(listener);
  }

  getEntryRender(key: string): TerminalViewportSurfaceProps | null {
    return this.entries.get(key)?.render ?? null;
  }

  acquire(slot: HTMLElement, props: TerminalViewportProps): TerminalViewBorrow {
    const entry = this.ensureEntry(props);
    const borrower: Borrower = { id: ++this.nextBorrowerId, slot, props };
    entry.borrowers.push(borrower);
    this.reconcile(entry);
    let released = false;
    return {
      update: (next) => {
        if (released) return;
        borrower.props = next;
        this.reconcile(entry);
      },
      release: () => {
        if (released) return;
        released = true;
        entry.borrowers = entry.borrowers.filter((current) => current !== borrower);
        if (this.entries.get(entry.key) !== entry) return;
        this.reconcile(entry);
        if (!entry.attached && !this.isListed(entry.threadId, entry.terminalId))
          this.disposeEntry(entry);
      },
    };
  }

  setRestorable(key: string, restorable: boolean): void {
    const entry = this.entries.get(key);
    if (!entry || entry.restorable === restorable) return;
    entry.restorable = restorable;
    this.scheduleParkCheck();
  }

  prune(): void {
    // Deleting the current Map entry during iteration is safe.
    for (const entry of this.entries.values())
      if (!entry.attached && !this.isListed(entry.threadId, entry.terminalId))
        this.disposeEntry(entry);
  }

  /** Panes of `threadId` attached to an on-screen, non-inert slot while the document is visible. */
  visibleTerminalIds(threadId: string): string[] {
    if (typeof document === "undefined" || document.visibilityState !== "visible") return [];
    const ids: string[] = [];
    for (const entry of this.entries.values()) {
      if (entry.threadId !== threadId || !entry.attached || !entry.render.visible) continue;
      const borrower = activeBorrower(entry);
      if (borrower && isTerminalViewSlotOnScreen(borrower.slot)) ids.push(entry.terminalId);
    }
    return ids.toSorted().slice(0, MAX_REPORTED_VIEWS);
  }

  viewState(threadId: string, terminalId: string): TerminalViewState | null {
    const entry = this.entries.get(terminalViewKey(threadId, terminalId));
    return entry ? terminalViewState(entry) : null;
  }

  /** Runs the park policy now (tests and diagnostics); timers call it on their own. */
  runParkCheck(): void {
    if (this.parkTimer !== null) this.clock.clearTimeout(this.parkTimer);
    this.parkTimer = null;
    const now = this.clock.now();
    let changed = false;
    for (const key of selectTerminalViewsToPark([...this.entries.values()], now)) {
      const entry = this.entries.get(key)!;
      entry.mounted = false;
      changed = true;
      recordTerminalViewRegistryEvent(entry.threadId, entry.terminalId, "parked");
    }
    if (changed) this.refreshMountedList();
    this.scheduleParkCheck();
  }

  private ensureEntry(props: TerminalViewportProps): Entry {
    const key = terminalViewKey(props.threadId, props.terminalId);
    const existing = this.entries.get(key);
    if (existing) return existing;
    const callbacks = {
      onSessionExited: () => this.latestProps(key)?.onSessionExited(),
      onAddTerminalContext: (selection: TerminalContextSelection) =>
        this.latestProps(key)?.onAddTerminalContext(selection),
      onRestorableChange: (restorable: boolean) => this.setRestorable(key, restorable),
    };
    const entry: Entry = {
      key,
      threadId: props.threadId,
      terminalId: props.terminalId,
      surfaceKey: props.threadId,
      host: createTerminalViewHost(),
      borrowers: [],
      lastProps: props,
      render: { ...props, ...callbacks },
      attached: false,
      mounted: false,
      restorable: false,
      lastAttachedAt: this.clock.now(),
      releasedAt: null,
      callbacks,
      listeners: new Set(),
    };
    this.entries.set(key, entry);
    return entry;
  }

  private latestProps(key: string): TerminalViewportProps | undefined {
    const entry = this.entries.get(key);
    return entry ? (activeBorrower(entry)?.props ?? entry.lastProps) : undefined;
  }

  private reconcile(entry: Entry): void {
    const borrower = activeBorrower(entry);
    const now = this.clock.now();
    let listChanged = false;
    if (borrower) {
      entry.lastProps = borrower.props;
      releaseTerminalViewHostSize(entry.host);
      moveTerminalViewHost(borrower.slot, entry.host);
      if (!entry.attached)
        recordTerminalViewRegistryEvent(
          entry.threadId,
          entry.terminalId,
          entry.mounted ? "attached" : "restored",
        );
      entry.attached = true;
      entry.releasedAt = null;
      entry.lastAttachedAt = now;
      if (!entry.mounted) {
        entry.mounted = true;
        listChanged = true;
      }
    } else if (entry.attached) {
      entry.attached = false;
      entry.releasedAt = now;
      freezeTerminalViewHostSize(entry.host);
      if (this.holder) moveTerminalViewHost(this.holder, entry.host);
      recordTerminalViewRegistryEvent(entry.threadId, entry.terminalId, "warm");
    }
    const inert = !borrower || isTerminalViewSlotInert(borrower.slot);
    const props = entry.lastProps;
    const render: TerminalViewportSurfaceProps = {
      ...props,
      ...entry.callbacks,
      visible: !inert && props.visible,
      autoFocus: !inert && props.autoFocus,
    };
    if (!shallowEqual(render, entry.render)) {
      entry.render = render;
      this.emit(entry.listeners);
    }
    if (listChanged) this.refreshMountedList();
    this.emit(this.changeListeners);
    this.scheduleParkCheck();
  }

  private scheduleParkCheck(): void {
    this.enforceViewCap();
    if (this.parkTimer !== null) this.clock.clearTimeout(this.parkTimer);
    this.parkTimer = null;
    const entries = [...this.entries.values()];
    const now = this.clock.now();
    if (selectTerminalViewsToPark(entries, now).length > 0) {
      this.parkTimer = this.clock.setTimeout(() => this.runParkCheck(), 0);
      return;
    }
    const next = nextTerminalViewParkCheck(entries, now);
    if (next !== null)
      this.parkTimer = this.clock.setTimeout(() => this.runParkCheck(), next - now);
  }

  private enforcingCap = false;

  /** Unrestorable released views beyond the warm cap are disposed, least recently used first. */
  private enforceViewCap(): void {
    if (this.enforcingCap) return;
    this.enforcingCap = true;
    try {
      for (const key of selectTerminalViewsToEvict([...this.entries.values()])) {
        const entry = this.entries.get(key);
        if (entry) this.disposeEntry(entry);
      }
    } finally {
      this.enforcingCap = false;
    }
  }

  private disposeEntry(entry: Entry): void {
    if (this.entries.get(entry.key) !== entry) return;
    this.entries.delete(entry.key);
    entry.host.remove();
    entry.listeners.clear();
    recordTerminalViewRegistryEvent(entry.threadId, entry.terminalId, "disposed");
    if (entry.mounted) this.refreshMountedList();
    this.emit(this.changeListeners);
    this.scheduleParkCheck();
  }

  /** Disposes every view (tests, and teardown of the whole app). */
  disposeAll(): void {
    for (const entry of this.entries.values()) this.disposeEntry(entry);
  }

  private refreshMountedList(): void {
    this.mountedList = [...this.entries.values()].filter((entry) => entry.mounted);
    this.emit(this.listListeners);
  }

  private listen(listeners: Set<() => void>, listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  private emit(listeners: Set<() => void>): void {
    for (const listener of listeners) listener();
  }
}

export const terminalViewRegistry = new TerminalViewRegistry();
