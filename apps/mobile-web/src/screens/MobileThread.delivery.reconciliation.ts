import type { MobileCommandDeliveryController } from "../lib/mobileCommandDelivery";
import type { MobileCommandDeliveryState } from "../lib/mobileCommandDelivery.logic";
import type { MobileRecoveryFreshness } from "../logic/mobileRecovery.types";

/**
 * The command ID to check automatically, or null. Only an uncertain send that
 * has not already come back "unknown" qualifies, at most once per caught-up
 * period. A resend always stays the user's choice.
 */
export function selectCommandToRecheck(input: {
  readonly freshness: MobileRecoveryFreshness;
  readonly state: MobileCommandDeliveryState;
  readonly checked: ReadonlySet<string>;
}): string | null {
  if (input.freshness !== "current" || input.state.operation?.receiptSource) return null;
  const commandId = input.state.operation?.command.commandId ?? null;
  if (input.state.status !== "uncertain" || input.state.outcomeUnknown || commandId === null) {
    return null;
  }
  return input.checked.has(commandId) ? null : commandId;
}

/** Receipt reads are distinct from dispatch; selecting never resends a command. */
export function createMobileDeliveryReconciliationTracker() {
  let checkedByController = new WeakMap<MobileCommandDeliveryController, Set<string>>();
  return {
    reset: () => {
      checkedByController = new WeakMap();
    },
    select(controller: MobileCommandDeliveryController) {
      let checked = checkedByController.get(controller);
      if (!checked) {
        checked = new Set();
        checkedByController.set(controller, checked);
      }
      const commandId = selectCommandToRecheck({
        freshness: "current",
        state: controller.getState(),
        checked,
      });
      if (commandId !== null) checked.add(commandId);
      return commandId;
    },
  };
}
