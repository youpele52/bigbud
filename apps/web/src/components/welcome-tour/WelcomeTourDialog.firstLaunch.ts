import { useEffect } from "react";

import { useWelcomeTourStore, type WelcomeTourMode } from "../../stores/ui/welcomeTour.store";

export interface FirstLaunchTourGateInput {
  readonly bootstrapComplete: boolean;
  readonly hasLoadedServerConfig: boolean;
  readonly hasSeenFileAccessPrompt: boolean;
  readonly hasSeenWelcomeTour: boolean;
}

/**
 * New installs (no File Access decision yet) get the whole welcome tour once. Anyone who already
 * saw the tour but has no File Access decision (Settings → File Access → Reset permissions) is
 * asked only the File Access question again. Everyone else sees nothing.
 */
export function resolveFirstLaunchTourMode(
  input: FirstLaunchTourGateInput,
): WelcomeTourMode | null {
  if (!input.bootstrapComplete || !input.hasLoadedServerConfig || input.hasSeenFileAccessPrompt) {
    return null;
  }
  return input.hasSeenWelcomeTour ? "file-access" : "tour";
}

/** Same moment the File Access question used to appear: shortly after bootstrap and config load. */
export const FIRST_LAUNCH_TOUR_DELAY_MS = 800;

export function useFirstLaunchWelcomeTour(input: FirstLaunchTourGateInput): void {
  const { bootstrapComplete, hasLoadedServerConfig, hasSeenFileAccessPrompt, hasSeenWelcomeTour } =
    input;
  useEffect(() => {
    const mode = resolveFirstLaunchTourMode({
      bootstrapComplete,
      hasLoadedServerConfig,
      hasSeenFileAccessPrompt,
      hasSeenWelcomeTour,
    });
    if (!mode) return;
    const timer = setTimeout(() => {
      useWelcomeTourStore.getState().openTour(mode);
    }, FIRST_LAUNCH_TOUR_DELAY_MS);
    return () => clearTimeout(timer);
  }, [bootstrapComplete, hasLoadedServerConfig, hasSeenFileAccessPrompt, hasSeenWelcomeTour]);
}
