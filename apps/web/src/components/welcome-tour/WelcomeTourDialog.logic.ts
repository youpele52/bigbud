import type { ServerProvider } from "@bigbud/contracts";

import type { WelcomeTourMode } from "../../stores/ui/welcomeTour.store";

export type WelcomeTourStep = "name" | "providers" | "file-access";

const STEPS_BY_MODE: Record<WelcomeTourMode, ReadonlyArray<WelcomeTourStep>> = {
  tour: ["name", "providers", "file-access"],
  "file-access": ["file-access"],
};

export function welcomeTourSteps(mode: WelcomeTourMode): ReadonlyArray<WelcomeTourStep> {
  return STEPS_BY_MODE[mode];
}

/** Marks the tour and the first-launch File Access question as answered, without a level. */
export const WELCOME_TOUR_SEEN_PATCH = {
  hasSeenWelcomeTour: true,
  hasSeenFileAccessPrompt: true,
} as const;

/** `null` while the server has not reported provider status yet. */
export function countDiscoveredProviders(
  serverProviders: ReadonlyArray<ServerProvider>,
): number | null {
  if (serverProviders.length === 0) return null;
  return serverProviders.filter((provider) => provider.installed).length;
}

export function describeDiscoveredProviders(found: number | null): string {
  if (found === null) return "bigbud is checking which AI providers are on this computer.";
  if (found === 0) return "bigbud didn’t find an AI provider on this computer yet.";
  return `bigbud found ${found} AI ${found === 1 ? "provider" : "providers"} on this computer.`;
}
