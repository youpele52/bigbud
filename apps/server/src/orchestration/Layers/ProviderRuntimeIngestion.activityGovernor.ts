import {
  EventId,
  type OrchestrationThreadActivity,
  type ThreadId,
  type TurnId,
} from "@bigbud/contracts";

const DEFAULT_MAX_ROWS_PER_TURN = 120;
const DEFAULT_MAX_ROWS_PER_CATEGORY = 40;
const DEFAULT_MAX_UPDATES_PER_IDENTITY = 12;
const DEFAULT_MAX_BYTES_PER_TURN = 200_000;
const DEFAULT_MAX_BYTES_PER_CATEGORY = 50_000;
const DEFAULT_MAX_BYTES_PER_IDENTITY = 10_000;
const MAX_TRACKED_TURNS = 256;

interface ActivityGovernorState {
  readonly rows: Set<string>;
  readonly rowsByCategory: Map<string, number>;
  readonly updatesByIdentity: Map<string, number>;
  readonly bytesByCategory: Map<string, number>;
  readonly bytesByIdentity: Map<string, number>;
  bytes: number;
  readonly suppressedByCategory: Map<string, number>;
}

export interface ActivityGovernorOptions {
  readonly maxRowsPerTurn?: number;
  readonly maxRowsPerCategory?: number;
  readonly maxUpdatesPerIdentity?: number;
  readonly maxBytesPerTurn?: number;
  readonly maxBytesPerCategory?: number;
  readonly maxBytesPerIdentity?: number;
}

function categoryFor(activity: OrchestrationThreadActivity): string {
  const [category] = activity.kind.split(".");
  return category || "other";
}

function isTerminal(activity: OrchestrationThreadActivity): boolean {
  if (activity.tone === "error" || activity.kind.endsWith(".completed")) return true;
  if (activity.kind.startsWith("request.") || activity.kind.startsWith("user-input.")) return true;
  const payload = activity.payload;
  return (
    activity.kind === "hook.updated" &&
    typeof payload === "object" &&
    payload !== null &&
    "outcome" in payload
  );
}

function makeState(): ActivityGovernorState {
  return {
    rows: new Set(),
    rowsByCategory: new Map(),
    updatesByIdentity: new Map(),
    bytesByCategory: new Map(),
    bytesByIdentity: new Map(),
    bytes: 0,
    suppressedByCategory: new Map(),
  };
}

/** Bounds repetitive runtime work-log activity while preserving terminal and interactive events. */
export class RuntimeActivityGovernor {
  readonly #states = new Map<string, ActivityGovernorState>();
  readonly #maxRowsPerTurn: number;
  readonly #maxRowsPerCategory: number;
  readonly #maxUpdatesPerIdentity: number;
  readonly #maxBytesPerTurn: number;
  readonly #maxBytesPerCategory: number;
  readonly #maxBytesPerIdentity: number;

  constructor(options: ActivityGovernorOptions = {}) {
    this.#maxRowsPerTurn = options.maxRowsPerTurn ?? DEFAULT_MAX_ROWS_PER_TURN;
    this.#maxRowsPerCategory = options.maxRowsPerCategory ?? DEFAULT_MAX_ROWS_PER_CATEGORY;
    this.#maxUpdatesPerIdentity = options.maxUpdatesPerIdentity ?? DEFAULT_MAX_UPDATES_PER_IDENTITY;
    this.#maxBytesPerTurn = options.maxBytesPerTurn ?? DEFAULT_MAX_BYTES_PER_TURN;
    this.#maxBytesPerCategory = options.maxBytesPerCategory ?? DEFAULT_MAX_BYTES_PER_CATEGORY;
    this.#maxBytesPerIdentity = options.maxBytesPerIdentity ?? DEFAULT_MAX_BYTES_PER_IDENTITY;
  }

  take(input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId | null;
    readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  }): ReadonlyArray<OrchestrationThreadActivity> {
    const key = `${input.threadId}:${input.turnId ?? "session"}`;
    const state = this.#stateFor(key);
    const accepted: OrchestrationThreadActivity[] = [];

    for (const activity of input.activities) {
      const identity = String(activity.id);
      const category = categoryFor(activity);
      const isExisting = state.rows.has(identity);
      const updates = state.updatesByIdentity.get(identity) ?? 0;
      const categoryRows = state.rowsByCategory.get(category) ?? 0;
      const bytes = activityByteSize(activity);
      const categoryBytes = state.bytesByCategory.get(category) ?? 0;
      const identityBytes = state.bytesByIdentity.get(identity) ?? 0;
      const overBudget =
        !isTerminal(activity) &&
        ((isExisting && updates >= this.#maxUpdatesPerIdentity) ||
          (!isExisting &&
            (state.rows.size >= this.#maxRowsPerTurn ||
              categoryRows >= this.#maxRowsPerCategory)) ||
          state.bytes + bytes > this.#maxBytesPerTurn ||
          categoryBytes + bytes > this.#maxBytesPerCategory ||
          identityBytes + bytes > this.#maxBytesPerIdentity);

      if (overBudget) {
        accepted.push(this.#suppressionActivity({ activity, category, scopeKey: key, state }));
        continue;
      }

      if (!isExisting) {
        state.rows.add(identity);
        state.rowsByCategory.set(category, categoryRows + 1);
      }
      state.updatesByIdentity.set(identity, updates + 1);
      state.bytes += bytes;
      state.bytesByCategory.set(category, categoryBytes + bytes);
      state.bytesByIdentity.set(identity, identityBytes + bytes);
      accepted.push(activity);
    }
    return accepted;
  }

  clear(input: { readonly threadId: ThreadId; readonly turnId: TurnId | null }): void {
    this.#states.delete(`${input.threadId}:${input.turnId ?? "session"}`);
  }

  #stateFor(key: string): ActivityGovernorState {
    const current = this.#states.get(key);
    if (current) return current;
    if (this.#states.size >= MAX_TRACKED_TURNS) {
      const oldest = this.#states.keys().next().value;
      if (oldest) this.#states.delete(oldest);
    }
    const state = makeState();
    this.#states.set(key, state);
    return state;
  }

  #suppressionActivity(input: {
    readonly activity: OrchestrationThreadActivity;
    readonly category: string;
    readonly scopeKey: string;
    readonly state: ActivityGovernorState;
  }): OrchestrationThreadActivity {
    const suppressed = (input.state.suppressedByCategory.get(input.category) ?? 0) + 1;
    input.state.suppressedByCategory.set(input.category, suppressed);
    return {
      id: EventId.makeUnsafe(`activity-suppressed:${input.scopeKey}:${input.category}`),
      createdAt: input.activity.createdAt,
      tone: "info",
      kind: "runtime.activity.suppressed",
      summary: "Repetitive activity updates suppressed",
      payload: { category: input.category, suppressed },
      turnId: input.activity.turnId,
    };
  }
}

function activityByteSize(activity: OrchestrationThreadActivity): number {
  try {
    return new TextEncoder().encode(JSON.stringify(activity)).byteLength;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}
