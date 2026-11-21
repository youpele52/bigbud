import {
  SYSTEM_SEARCH_LOCAL_SOURCE_ID,
  SYSTEM_SEARCH_MAX_PAGE,
  type SystemSearchHit,
  type SystemSearchQueryInput,
  type SystemSearchReason,
  type SystemSearchSourceState,
  type SystemSearchTier,
  type SystemSearchTierUpdate,
} from "@bigbud/contracts/search/systemSearch.ts";
import { boostOpenedFiles } from "./SearchPalette.frecency.logic";
import { countUnicodeCodePoints } from "@bigbud/shared/String";

import { osIndexWording } from "~/lib/osIndexWording";

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
  /** The last page asked per tier (0, the first page, when absent). */
  readonly pages: Readonly<Partial<Record<SystemSearchTier, number>>>;
}

export const EMPTY_SYSTEM_SEARCH_VIEW: SystemSearchView = {
  queryId: null,
  sources: [],
  finished: true,
  failed: false,
  pages: {},
};

export function startSystemSearchView(queryId: string): SystemSearchView {
  return { queryId, sources: [], finished: false, failed: false, pages: {} };
}

/**
 * Starts the next page of one tier under a new query generation. Rows already shown stay; the
 * tier's sources go back to searching with their truncation cleared, so the page decides it.
 */
export function beginSystemSearchPage(
  view: SystemSearchView,
  queryId: string,
  tier: SystemSearchTier,
  page: number,
): SystemSearchView {
  return {
    ...view,
    queryId,
    finished: false,
    failed: false,
    pages: { ...view.pages, [tier]: page },
    sources: view.sources.map((source) =>
      source.tier === tier ? { ...source, state: "searching", truncated: false } : source,
    ),
  };
}

/** The next page index for a tier, or null when the tier has no more rows to ask for. */
export function nextSystemSearchPage(
  view: SystemSearchView,
  tier: SystemSearchTier,
): number | null {
  if (view.queryId === null || !view.finished) return null;
  const sources = view.sources.filter((source) => source.tier === tier);
  const more = sources.some((source) => source.truncated && source.state !== "unavailable");
  const page = (view.pages[tier] ?? 0) + 1;
  return more && page <= SYSTEM_SEARCH_MAX_PAGE ? page : null;
}

function sourceRank(source: SystemSearchSourceView): number {
  return source.sourceId === SYSTEM_SEARCH_LOCAL_SOURCE_ID ? 0 : 1;
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
  openedRank: ReadonlyMap<string, number> = new Map(),
): SystemSearchHit[] {
  const rows = view.sources
    .filter((source) => source.tier === tier)
    .flatMap((source) => source.items);
  return boostOpenedFiles(rows, openedRank);
}

/** The freshness caveat for a view's T5 rows, from the OS index that answered (`locate`). */
export function thisComputerNote(view: SystemSearchView): string | null {
  const source = view.sources.find((candidate) => candidate.tier === "thisComputer");
  return source ? osIndexWording(source.sourceId).staleNote : null;
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

/**
 * One notice per source and reason, in tier order, for the palette's notice rows. Mod+F passes
 * its fast and slow streams' views, in that order, so a source in both is noticed once.
 */
export function systemSearchNotices(...views: readonly SystemSearchView[]): SystemSearchNotice[] {
  const seen = new Set<string>();
  const notices: SystemSearchNotice[] = [];
  for (const source of views.flatMap((view) => view.sources)) {
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

/** "Search this computer" is on and File Access allows it (the server enforces the same gate). */
export function isThisComputerSearchOn(settings: {
  readonly search: { readonly thisComputer: boolean; readonly fileAccessLevel: string };
}): boolean {
  return settings.search.thisComputer && settings.search.fileAccessLevel !== "none";
}

/**
 * Tiers worth asking for (plan "Short queries"): current project from 1, the rest from 2.
 * `thisComputer` is the effective setting (on and File Access not "No access"). Mod+P leaves the
 * current project out when its in-memory local list already answers it; Mod+F asks for the
 * current project and the slow tiers in separate streams (`slowTiers: false` for the first).
 */
export function systemSearchTiersFor(
  query: string,
  options: {
    readonly thisComputer: boolean;
    readonly currentProject?: boolean;
    readonly slowTiers?: boolean;
  },
): SystemSearchTier[] {
  const length = countUnicodeCodePoints(query.trim());
  const current = options.currentProject === false ? [] : (["currentProject"] as const);
  if (length === 0) return [];
  if (length === 1 || options.slowTiers === false) return [...current];
  return [
    ...current,
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
  const start = (
    input: SystemSearchQueryInput,
    begin: (view: SystemSearchView) => SystemSearchView,
  ) => {
    const queryId = input.queryId;
    const current = new AbortController();
    controller = current;
    onView(begin);
    const settle = (failed: boolean) =>
      onView((view) => (view.queryId === queryId ? { ...view, finished: true, failed } : view));
    search(
      input,
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
      start({ ...input, queryId }, () => startSystemSearchView(queryId));
    },
    /**
     * The next page of one tier (scrolled to). It supersedes whatever query is live, so at most
     * one `search.query` runs per palette; rows already shown stay and new ones append.
     */
    more(input: Omit<SystemSearchQueryInput, "queryId" | "tiers">, tier: SystemSearchTier) {
      cancel();
      const queryId = makeQueryId();
      const page = input.page ?? 1;
      start({ ...input, tiers: [tier], page, queryId }, (view) =>
        beginSystemSearchPage(view, queryId, tier, page),
      );
    },
  };
}
