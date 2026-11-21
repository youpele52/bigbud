/**
 * Host-owned panes the manager has no session for yet (plan §8.2 "Server sessions … rebuilt
 * from host inventory"). After a backend restart the host still runs terminals that no view has
 * reopened; the inventory must list them, or restored panes would be dropped (W1), and their
 * ids must keep counting as the thread's panes (N8).
 *
 * @module Manager.hostRoster
 */
import type { OwnedPtyRuntime } from "../Services/OwnedPtyRuntime.ts";
import { paneFromOwnerKey } from "./Manager.hostLimit.ts";

export interface TerminalHostRosterEntry {
  readonly threadId: string;
  readonly terminalId: string;
  readonly ptyId: string;
  /** The host lost this PTY (a host crash); only a cold screen remains. */
  readonly lost: boolean;
  readonly activityState?: string;
  readonly lastUsedMs?: number;
}

const OWNER_PAGE = 100;
const OWNER_PAGES = 64;

/** Every durable owner row of the runtime's target, all states, bounded. */
export async function listTerminalHostOwners(runtime: OwnedPtyRuntime) {
  const list = runtime.owners().listTerminalOwners;
  if (!list) throw new Error("This runtime cannot list its terminal owners.");
  const owners = [];
  let cursor: string | undefined;
  for (let page = 0; page < OWNER_PAGES; page++) {
    const result = await list(runtime.targetId, cursor, OWNER_PAGE);
    owners.push(...result.owners);
    if (!result.nextCursor) return owners;
    cursor = result.nextCursor;
  }
  throw new Error("Terminal owners exceed their listing bound.");
}

export class TerminalHostRoster {
  private current: ReadonlyArray<TerminalHostRosterEntry> = [];
  private loaded: Promise<void> | undefined;
  private running: Promise<void> | undefined;
  private again = false;

  constructor(
    private readonly runtime: () => OwnedPtyRuntime | undefined,
    private readonly log: (message: string, detail: Record<string, unknown>) => void,
  ) {}

  entries(): ReadonlyArray<TerminalHostRosterEntry> {
    return this.current;
  }

  /** The first load after adoption; later calls reuse it. Never rejects. */
  ready(): Promise<void> {
    this.loaded ??= (async () => {
      await this.runtime()?.hostGenerations?.ready();
      await this.refresh();
    })();
    return this.loaded;
  }

  /** Coalesced refresh; a failed read keeps the previous roster. */
  refresh(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.load().finally(() => {
      this.running = undefined;
      if (this.again) {
        this.again = false;
        void this.refresh();
      }
    });
    return this.running;
  }

  private async load(): Promise<void> {
    const runtime = this.runtime();
    const generations = runtime?.hostGenerations;
    if (!runtime || !generations) {
      this.current = [];
      return;
    }
    try {
      const [inventory, owners] = await Promise.all([
        generations.inventory(),
        listTerminalHostOwners(runtime),
      ]);
      const panes = new Map<string, { threadId: string; terminalId: string }>();
      for (const owner of owners) {
        const pane = owner.state === "terminal" ? undefined : paneFromOwnerKey(owner.ownerKey);
        if (pane) panes.set(owner.resourceId, pane);
      }
      const next: TerminalHostRosterEntry[] = [];
      for (const entry of inventory) {
        const pane = panes.get(entry.ptyId);
        if (!pane || (entry.state !== "running" && !entry.lost)) continue;
        next.push({
          ...pane,
          ptyId: entry.ptyId,
          lost: entry.lost,
          ...(entry.activityState ? { activityState: entry.activityState } : {}),
          ...(entry.lastUsedMs ? { lastUsedMs: entry.lastUsedMs } : {}),
        });
      }
      this.current = next;
    } catch (cause) {
      this.log("terminal host roster refresh failed", { cause: String(cause) });
    }
  }
}
