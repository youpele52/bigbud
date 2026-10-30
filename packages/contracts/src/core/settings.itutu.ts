import * as Schema from "effect/Schema";

/**
 * Ìtútù idle cleanup, in two steps. Server-owned so it runs with no client connected.
 * - Idle: Present threads with no activity for the timeout move to the destination (Later).
 * - Older threads: Present or Later threads with no activity for the age move to Done.
 * Both are on by default; neither ever moves running, queued, waiting, or snoozed threads.
 */
export const ITUTU_IDLE_TIMEOUT_MIN_MINUTES = 10;
export const ITUTU_IDLE_TIMEOUT_MAX_MINUTES = 24 * 60;
export const DEFAULT_ITUTU_IDLE_TIMEOUT_MINUTES = 10;

export const ITUTU_OLDER_THREADS_MIN_DAYS = 1;
export const ITUTU_OLDER_THREADS_MAX_DAYS = 30;
export const DEFAULT_ITUTU_OLDER_THREADS_DAYS = 1;

export const ItutuIdleTimeoutMinutes = Schema.Int.check(
  Schema.isBetween({
    minimum: ITUTU_IDLE_TIMEOUT_MIN_MINUTES,
    maximum: ITUTU_IDLE_TIMEOUT_MAX_MINUTES,
  }),
);
export type ItutuIdleTimeoutMinutes = typeof ItutuIdleTimeoutMinutes.Type;

export const ItutuOlderThreadsDays = Schema.Int.check(
  Schema.isBetween({
    minimum: ITUTU_OLDER_THREADS_MIN_DAYS,
    maximum: ITUTU_OLDER_THREADS_MAX_DAYS,
  }),
);
export type ItutuOlderThreadsDays = typeof ItutuOlderThreadsDays.Type;

/** Done is an organizational destination; it never claims the work succeeded. */
export const ItutuIdleDestination = Schema.Literals(["done", "later"]);
export type ItutuIdleDestination = typeof ItutuIdleDestination.Type;

export const ItutuIdleSettingsFields = {
  itutuIdleCleanupEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  itutuIdleTimeoutMinutes: ItutuIdleTimeoutMinutes.pipe(
    Schema.withDecodingDefault(() => DEFAULT_ITUTU_IDLE_TIMEOUT_MINUTES),
  ),
  itutuIdleDestination: ItutuIdleDestination.pipe(
    Schema.withDecodingDefault(() => "later" as const satisfies ItutuIdleDestination),
  ),
  itutuOlderThreadsEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  itutuOlderThreadsDays: ItutuOlderThreadsDays.pipe(
    Schema.withDecodingDefault(() => DEFAULT_ITUTU_OLDER_THREADS_DAYS),
  ),
};

export const ItutuIdleSettingsPatchFields = {
  itutuIdleCleanupEnabled: Schema.optionalKey(Schema.Boolean),
  itutuIdleTimeoutMinutes: Schema.optionalKey(ItutuIdleTimeoutMinutes),
  itutuIdleDestination: Schema.optionalKey(ItutuIdleDestination),
  itutuOlderThreadsEnabled: Schema.optionalKey(Schema.Boolean),
  itutuOlderThreadsDays: Schema.optionalKey(ItutuOlderThreadsDays),
};
