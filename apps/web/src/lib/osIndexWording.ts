import type { SystemSearchOsIndexSource } from "@bigbud/contracts/search/systemSearch.ts";

/** How the palette and Settings name "this computer" search for one OS index. */
export interface OsIndexWording {
  /** "this Mac", "this PC" or "this computer". */
  readonly place: string;
  /** The index's own name: Spotlight, Windows Search or locate. */
  readonly index: string;
  /** Why the index may be unavailable, shown with the "index unavailable" notice. */
  readonly unavailableHint: string;
  /** A freshness caveat, shown with its results (Linux `locate` reads a daily database). */
  readonly staleNote: string | null;
}

const WORDING: Readonly<Record<SystemSearchOsIndexSource, OsIndexWording>> = {
  spotlight: {
    place: "this Mac",
    index: "Spotlight",
    unavailableHint: "Spotlight may be off or still indexing",
    staleNote: null,
  },
  "windows-search": {
    place: "this PC",
    index: "Windows Search",
    unavailableHint: "the Windows Search service may be turned off",
    staleNote: null,
  },
  locate: {
    place: "this computer",
    index: "locate",
    unavailableHint: "plocate or locate may not be installed",
    staleNote: "Results come from the locate database, so they may be up to a day old.",
  },
};

const UNKNOWN: OsIndexWording = {
  place: "this computer",
  index: "system file index",
  unavailableHint: "the system file index may be off",
  staleNote: null,
};

export function isOsIndexSource(sourceId: string): sourceId is SystemSearchOsIndexSource {
  return Object.hasOwn(WORDING, sourceId);
}

/** Wording for a T5 `sourceId` (the agent's OS index), or generic wording for anything else. */
export function osIndexWording(sourceId: string | null): OsIndexWording {
  return sourceId !== null && isOsIndexSource(sourceId) ? WORDING[sourceId] : UNKNOWN;
}

/**
 * The OS index the desktop app's local agent uses on this platform (`navigator.platform`), for
 * Settings and the hint before any search ran; `null` where no adapter exists.
 */
export function osIndexSourceForPlatform(platform: string): SystemSearchOsIndexSource | null {
  if (/^mac/i.test(platform)) return "spotlight";
  if (/^win/i.test(platform)) return "windows-search";
  if (/linux/i.test(platform)) return "locate";
  return null;
}

export function currentOsIndexSource(): SystemSearchOsIndexSource | null {
  return typeof navigator === "undefined" ? null : osIndexSourceForPlatform(navigator.platform);
}
