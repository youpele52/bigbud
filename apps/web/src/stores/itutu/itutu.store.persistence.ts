import {
  THREAD_ORGANIZATION_STATES,
  type ThreadOrganizationState,
} from "@bigbud/contracts/orchestration/orchestration.organization.ts";

export type SidebarArrangement = "projects" | "itutu";

export interface PersistedItutuState {
  readonly arrangement: SidebarArrangement;
  readonly collapsedStates: readonly ThreadOrganizationState[];
}

const PERSISTED_ITUTU_STATE_KEY = "bigbud:itutu-ui:v1";

export const DEFAULT_PERSISTED_ITUTU_STATE: PersistedItutuState = {
  arrangement: "projects",
  collapsedStates: [],
};

const isState = (value: unknown): value is ThreadOrganizationState =>
  (THREAD_ORGANIZATION_STATES as readonly unknown[]).includes(value);

/** Reads the arrangement and collapsed groups, ignoring anything malformed. */
export function readPersistedItutuState(): PersistedItutuState {
  if (typeof window === "undefined") return DEFAULT_PERSISTED_ITUTU_STATE;
  try {
    const raw = window.localStorage.getItem(PERSISTED_ITUTU_STATE_KEY);
    if (!raw) return DEFAULT_PERSISTED_ITUTU_STATE;
    const parsed = JSON.parse(raw) as Partial<Record<keyof PersistedItutuState, unknown>>;
    return {
      arrangement: parsed.arrangement === "itutu" ? "itutu" : "projects",
      collapsedStates: Array.isArray(parsed.collapsedStates)
        ? parsed.collapsedStates.filter(isState)
        : [],
    };
  } catch {
    return DEFAULT_PERSISTED_ITUTU_STATE;
  }
}

export function persistItutuState(state: PersistedItutuState): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      PERSISTED_ITUTU_STATE_KEY,
      JSON.stringify({ arrangement: state.arrangement, collapsedStates: state.collapsedStates }),
    );
  } catch {
    // Storage can be full or unavailable; the arrangement still applies for this session.
  }
}
