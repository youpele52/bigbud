import type {
  SystemSearchHit,
  SystemSearchQueryInput,
  SystemSearchReason,
  SystemSearchSourceState,
  SystemSearchTier,
  SystemSearchTierUpdate,
} from "@bigbud/contracts/search/systemSearch.ts";
import { countUnicodeCodePoints } from "@bigbud/shared/String";

/** One source of one tier (for example T4 from the local agent, or T4 from one remote). */
export interface SystemSearchSourceView {
  readonly tier: SystemSearchTier;
  readonly sourceId: string;
  readonly state: SystemSearchSourceState;
  readonly reason?: SystemSearchReason | undefined;
  readonly truncated: boolean;
  readonly items: readonly SystemSearchHit[];
}

export interface SystemSearchView {
  /** The query generation this view belongs to; updates for any other generation are dropped. */
  readonly queryId: string | null;
  readonly sources: readonly SystemSearchSourceView[];
  readonly finished: boolean;
  readonly failed: boolean;
}

export const EMPTY_SYSTEM_SEARCH_VIEW: SystemSearchView = {
  queryId: null,
  sources: [],
  finished: true,
  failed: false,
};

export function startSystemSearchView(queryId: string): SystemSearchView {
  return { queryId, sources: [], finished: false, failed: false };
}

function sourceRank(source: SystemSearchSourceView): number {
  return source.sourceId === "local" ? 0 : 1;
}

/** The local machine's sources sort before remotes; remotes in a fixed order. */
function compareSources(left: SystemSearchSourceView, right: SystemSearchSourceView): number {
  return sourceRank(left) - sourceRank(right) || left.sourceId.localeCompare(right.sourceId);
}

/**
 * Merges one streamed update. Rows only ever append (deduplicated by stable ID), and sources
 * keep a fixed order, so rows already shown never change their relative order.
 */
export function applySystemSearchUpdate(
  view: SystemSearchView,
  update: SystemSearchTierUpdate,
): SystemSearchView {
  if (update.queryId !== view.queryId) return view;
  const index = view.sources.findIndex(
    (source) => source.tier === update.tier && source.sourceId === update.sourceId,
  );
  const previous = index >= 0 ? view.sources[index] : undefined;
  const known = new Set(previous?.items.map((item) => item.id));
  const added = update.items.filter((item) => !known.has(item.id));
  const merged: SystemSearchSourceView = {
    tier: update.tier,
    sourceId: update.sourceId,
    // Row updates are progress; only an update without rows sets the source's final state.
    state: update.items.length > 0 ? "partial" : update.state,
    reason: update.reason ?? previous?.reason,
    truncated: (previous?.truncated ?? false) || update.truncated,
    items: added.length > 0 ? [...(previous?.items ?? []), ...added] : (previous?.items ?? []),
  };
  const sources =
    index >= 0
      ? view.sources.map((source, position) => (position === index ? merged : source))
      : [...view.sources, merged].toSorted(compareSources);
  return { ...view, sources };
}

/** Every row of a tier, sources in fixed order, rows in arrival order. */
export function systemSearchTierRows(
  view: SystemSearchView,
  tier: SystemSearchTier,
): SystemSearchHit[] {
  return view.sources.filter((source) => source.tier === tier).flatMap((source) => source.items);
}

export function isSystemSearchTierPending(view: SystemSearchView, tier: SystemSearchTier): boolean {
  if (view.queryId === null || view.failed) return false;
  const sources = view.sources.filter((source) => source.tier === tier);
  return sources.length === 0
    ? !view.finished
    : sources.some((source) => source.state === "searching");
}

export interface SystemSearchNotice {
  readonly tier: SystemSearchTier;
  readonly sourceId: string;
  readonly reason: SystemSearchReason;
  readonly state: SystemSearchSourceState;
}

/** One notice per source and reason, in tier order, for the palette's notice rows. */
export function systemSearchNotices(view: SystemSearchView): SystemSearchNotice[] {
  const seen = new Set<string>();
  const notices: SystemSearchNotice[] = [];
  for (const source of view.sources) {
    if (!source.reason) continue;
    const key = `${source.sourceId}:${source.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    notices.push({
      tier: source.tier,
      sourceId: source.sourceId,
      reason: source.reason,
      state: source.state,
    });
  }
  return notices;
}

/** Tiers worth asking for (plan "Short queries"): current project from 1, the rest from 2. */
export function systemSearchTiersFor(
  query: string,
  options: { readonly thisComputer: boolean },
): SystemSearchTier[] {
  const length = countUnicodeCodePoints(query.trim());
  if (length === 0) return [];
  if (length === 1) return ["currentProject"];
  return [
    "currentProject",
    "otherProjectFiles",
    ...(options.thisComputer ? (["thisComputer"] as const) : []),
    "remoteOutsideProjects",
  ];
}

export type SystemSearchApi = (
  input: SystemSearchQueryInput,
  onUpdate: (update: SystemSearchTierUpdate) => void,
  signal: AbortSignal,
) => Promise<void>;

/**
 * Runs one query at a time: starting a query aborts the previous one, which cancels its work on
 * the server and agents, and its late updates are dropped by the generation check.
 */
export function createSystemSearchRunner(
  search: SystemSearchApi,
  onView: (update: (view: SystemSearchView) => SystemSearchView) => void,
  makeQueryId: () => string,
) {
  let controller: AbortController | null = null;
  const cancel = () => {
    controller?.abort();
    controller = null;
  };
  return {
    cancel,
    run(input: Omit<SystemSearchQueryInput, "queryId"> | null) {
      cancel();
      if (!input || input.tiers.length === 0) {
        onView(() => EMPTY_SYSTEM_SEARCH_VIEW);
        return;
      }
      const queryId = makeQueryId();
      const current = new AbortController();
      controller = current;
      onView(() => startSystemSearchView(queryId));
      const settle = (failed: boolean) =>
        onView((view) => (view.queryId === queryId ? { ...view, finished: true, failed } : view));
      search(
        { ...input, queryId },
        (update) => {
          if (!current.signal.aborted) onView((view) => applySystemSearchUpdate(view, update));
        },
        current.signal,
      ).then(
        () => {
          if (!current.signal.aborted) settle(false);
        },
        () => {
          if (!current.signal.aborted) settle(true);
        },
      );
    },
  };
}
