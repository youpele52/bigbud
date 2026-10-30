import type { ContextMenuItem, ThreadId } from "@bigbud/contracts";
import {
  THREAD_ORGANIZATION_STATES,
  type ThreadOrganization,
  type ThreadOrganizationState,
} from "@bigbud/contracts/orchestration/orchestration.organization.ts";

import { ITUTU_SNOOZE_PRESETS, moveThreadsToState, snoozeThread } from "./Sidebar.itutu.actions";
import { ITUTU_STATE_LABELS } from "./Sidebar.itutu.logic";

const MOVE_PREFIX = "itutu-move:";
const SNOOZE_PREFIX = "itutu-snooze:";
const CANCEL_SNOOZE_ID = "itutu-snooze-cancel";
const SNOOZE_INFO_ID = "itutu-snooze-info";

const formatWakeTime = (until: string) =>
  new Date(until).toLocaleString(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });

/**
 * The Move to submenu. With one thread, the current state is checked and snoozing is offered;
 * a multi-selection only offers the four states.
 */
export function buildItutuMoveMenuItem(
  organization: ThreadOrganization | undefined | null,
): ContextMenuItem {
  const single = organization !== null;
  const current = organization?.state ?? "present";
  const snooze = organization?.snooze ?? null;
  const states: ContextMenuItem[] = THREAD_ORGANIZATION_STATES.map((state) => ({
    id: `${MOVE_PREFIX}${state}`,
    label: ITUTU_STATE_LABELS[state],
    ...(single ? { checked: state === current } : {}),
  }));
  const snoozeItems: ContextMenuItem[] = !single
    ? []
    : [
        { id: "itutu-separator", label: "", separator: true },
        ...(snooze
          ? [
              {
                id: SNOOZE_INFO_ID,
                label: `Snoozed until ${formatWakeTime(snooze.until)}`,
                disabled: true,
              },
              { id: CANCEL_SNOOZE_ID, label: "Cancel snooze" },
            ]
          : []),
        ...ITUTU_SNOOZE_PRESETS.map((preset) => ({
          id: `${SNOOZE_PREFIX}${preset.minutes}`,
          label: `${snooze ? "Snooze again" : "Snooze"} ${preset.label}`,
        })),
      ];
  return { id: "itutu-move-to", label: "Move to", children: [...states, ...snoozeItems] };
}

/** Runs a Move to choice. Returns false when the clicked id is not an Ìtútù action. */
export async function runItutuMenuAction(
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
  if (clicked.startsWith(SNOOZE_PREFIX) && threadIds.length === 1) {
    const minutes = Number(clicked.slice(SNOOZE_PREFIX.length));
    if (!ITUTU_SNOOZE_PRESETS.some((preset) => preset.minutes === minutes)) return false;
    await snoozeThread(threadIds[0]!, minutes);
    return true;
  }
  return false;
}
