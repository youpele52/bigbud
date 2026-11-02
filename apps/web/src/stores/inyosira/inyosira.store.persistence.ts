import {
  THREAD_ORGANIZATION_STATES,
  type ThreadOrganizationState,
} from "@bigbud/contracts/orchestration/orchestration.organization.ts";

export type SidebarArrangement = "projects" | "inyosira";

export interface PersistedInyosiraState {
  readonly arrangement: SidebarArrangement;
  readonly collapsedStates: readonly ThreadOrganizationState[];
}

const PERSISTED_INYOSIRA_STATE_KEY = "bigbud:inyosira-ui:v1";

export const DEFAULT_PERSISTED_INYOSIRA_STATE: PersistedInyosiraState = {
  arrangement: "projects",
  collapsedStates: [],
};

const isState = (value: unknown): value is ThreadOrganizationState =>
  (THREAD_ORGANIZATION_STATES as readonly unknown[]).includes(value);

/** Reads the arrangement and collapsed groups, ignoring anything malformed. */
export function readPersistedInyosiraState(): PersistedInyosiraState {
  if (typeof window === "undefined") return DEFAULT_PERSISTED_INYOSIRA_STATE;
  try {
    const raw = window.localStorage.getItem(PERSISTED_INYOSIRA_STATE_KEY);
    if (!raw) return DEFAULT_PERSISTED_INYOSIRA_STATE;
    const parsed = JSON.parse(raw) as Partial<Record<keyof PersistedInyosiraState, unknown>>;
    return {
      arrangement: parsed.arrangement === "inyosira" ? "inyosira" : "projects",
      collapsedStates: Array.isArray(parsed.collapsedStates)
        ? parsed.collapsedStates.filter(isState)
        : [],
    };
  } catch {
    return DEFAULT_PERSISTED_INYOSIRA_STATE;
  }
}

export function persistInyosiraState(state: PersistedInyosiraState): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      PERSISTED_INYOSIRA_STATE_KEY,
      JSON.stringify({ arrangement: state.arrangement, collapsedStates: state.collapsedStates }),
    );
  } catch {
    // Storage can be full or unavailable; the arrangement still applies for this session.
  }
}
