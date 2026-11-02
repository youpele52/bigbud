import type { ContextMenuItem, ThreadId } from "@bigbud/contracts";
import {
  THREAD_ORGANIZATION_STATES,
  type ThreadOrganization,
  type ThreadOrganizationState,
} from "@bigbud/contracts/orchestration/orchestration.organization.ts";

import {
  INYOSIRA_SNOOZE_PRESETS,
  moveThreadsToState,
  snoozeThread,
} from "./Sidebar.inyosira.actions";
import { INYOSIRA_STATE_LABELS } from "./Sidebar.inyosira.logic";
import {
  formatSnoozeWakeTime,
  useInyosiraSnoozePickerStore,
} from "./Sidebar.inyosira.snoozePicker";

const MOVE_PREFIX = "inyosira-move:";
const SNOOZE_PREFIX = "inyosira-snooze:";
const CANCEL_SNOOZE_ID = "inyosira-snooze-cancel";
const SNOOZE_INFO_ID = "inyosira-snooze-info";
const SNOOZE_CUSTOM_ID = "inyosira-snooze-custom";

/**
 * The Move to submenu. With one thread, the current state is checked and snoozing is offered;
 * a multi-selection only offers the four states.
 */
export function buildInyosiraMoveMenuItem(
  organization: ThreadOrganization | undefined | null,
): ContextMenuItem {
  const single = organization !== null;
  const current = organization?.state ?? "present";
  const snooze = organization?.snooze ?? null;
  const states: ContextMenuItem[] = THREAD_ORGANIZATION_STATES.map((state) => ({
    id: `${MOVE_PREFIX}${state}`,
    label: INYOSIRA_STATE_LABELS[state],
    ...(single ? { checked: state === current } : {}),
  }));
  const snoozeItems: ContextMenuItem[] = !single
    ? []
    : [
        { id: "inyosira-separator", label: "", separator: true },
        ...(snooze
          ? [
              {
                id: SNOOZE_INFO_ID,
                label: `Snoozed until ${formatSnoozeWakeTime(new Date(snooze.until))}`,
                disabled: true,
              },
              { id: CANCEL_SNOOZE_ID, label: "Cancel snooze" },
            ]
          : []),
        ...INYOSIRA_SNOOZE_PRESETS.map((preset) => ({
          id: `${SNOOZE_PREFIX}${preset.minutes}`,
          label: `${snooze ? "Snooze again" : "Snooze"} ${preset.label}`,
        })),
        { id: SNOOZE_CUSTOM_ID, label: snooze ? "Snooze again for…" : "Snooze for…" },
      ];
  return { id: "inyosira-move-to", label: "Move to", children: [...states, ...snoozeItems] };
}

/** Runs a Move to choice. Returns false when the clicked id is not an Inyosira action. */
export async function runInyosiraMenuAction(
  clicked: string | null,
  threadIds: readonly ThreadId[],
): Promise<boolean> {
  if (clicked === null) return false;
  if (clicked.startsWith(MOVE_PREFIX)) {
    const state = clicked.slice(MOVE_PREFIX.length) as ThreadOrganizationState;
    if (!THREAD_ORGANIZATION_STATES.includes(state)) return false;
    await moveThreadsToState(threadIds, state);
    return true;
  }
  if (clicked === CANCEL_SNOOZE_ID) {
    await moveThreadsToState(threadIds, "present");
    return true;
  }
  if (clicked === SNOOZE_CUSTOM_ID && threadIds.length === 1) {
    useInyosiraSnoozePickerStore.getState().open(threadIds[0]!);
    return true;
  }
  if (clicked.startsWith(SNOOZE_PREFIX) && threadIds.length === 1) {
    const minutes = Number(clicked.slice(SNOOZE_PREFIX.length));
    if (!INYOSIRA_SNOOZE_PRESETS.some((preset) => preset.minutes === minutes)) return false;
    await snoozeThread(threadIds[0]!, minutes);
    return true;
  }
  return false;
}
