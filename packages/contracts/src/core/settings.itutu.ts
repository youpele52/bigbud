import * as Schema from "effect/Schema";

/**
 * Ìtútù idle cleanup: Present threads with no activity for the timeout move to the destination.
 * Server-owned so it runs with no client connected. Off until the user turns it on.
 */
export const ITUTU_IDLE_TIMEOUT_MIN_MINUTES = 1;
export const ITUTU_IDLE_TIMEOUT_MAX_MINUTES = 7 * 24 * 60;
export const DEFAULT_ITUTU_IDLE_TIMEOUT_MINUTES = 10;

export const ItutuIdleTimeoutMinutes = Schema.Int.check(
  Schema.isBetween({
    minimum: ITUTU_IDLE_TIMEOUT_MIN_MINUTES,
    maximum: ITUTU_IDLE_TIMEOUT_MAX_MINUTES,
  }),
);
export type ItutuIdleTimeoutMinutes = typeof ItutuIdleTimeoutMinutes.Type;

/** Done is an organizational destination; it never claims the work succeeded. */
export const ItutuIdleDestination = Schema.Literals(["done", "later"]);
export type ItutuIdleDestination = typeof ItutuIdleDestination.Type;

export const ItutuIdleSettingsFields = {
  itutuIdleCleanupEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
  itutuIdleTimeoutMinutes: ItutuIdleTimeoutMinutes.pipe(
    Schema.withDecodingDefault(() => DEFAULT_ITUTU_IDLE_TIMEOUT_MINUTES),
  ),
  itutuIdleDestination: ItutuIdleDestination.pipe(
    Schema.withDecodingDefault(() => "done" as const satisfies ItutuIdleDestination),
  ),
};

export const ItutuIdleSettingsPatchFields = {
  itutuIdleCleanupEnabled: Schema.optionalKey(Schema.Boolean),
  itutuIdleTimeoutMinutes: Schema.optionalKey(ItutuIdleTimeoutMinutes),
  itutuIdleDestination: Schema.optionalKey(ItutuIdleDestination),
};
