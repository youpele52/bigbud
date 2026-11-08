import type { ServerSettings } from "@bigbud/contracts";

/** Settings-derived cleanup rule descriptions. Pure settings logic: no scheduling here. */
export type IdlePolicy = Pick<
  ServerSettings,
  | "inyosiraIdleCleanupEnabled"
  | "inyosiraIdleTimeoutMinutes"
  | "inyosiraIdleDestination"
  | "inyosiraOlderThreadsEnabled"
  | "inyosiraOlderThreadsDays"
>;

export interface IdleRule {
  readonly name: "idle" | "older";
  readonly enabled: boolean;
  readonly timeoutMs: number;
  readonly fromStates: ReadonlyArray<"present" | "later">;
  readonly destination: "done" | "later";
}

/** The two rules a settings snapshot describes, in the order a tick applies them. */
export function idleRulesFor(settings: IdlePolicy): ReadonlyArray<IdleRule> {
  return [
    {
      name: "idle",
      enabled: settings.inyosiraIdleCleanupEnabled,
      timeoutMs: settings.inyosiraIdleTimeoutMinutes * 60_000,
      fromStates: ["present"],
      destination: settings.inyosiraIdleDestination,
    },
    {
      name: "older",
      enabled: settings.inyosiraOlderThreadsEnabled,
      timeoutMs: settings.inyosiraOlderThreadsDays * 24 * 60 * 60_000,
      fromStates: ["present", "later"],
      destination: "done",
    },
  ];
}
