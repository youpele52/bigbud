import * as Schema from "effect/Schema";

/**
 * Inyosira idle cleanup, in two steps. Server-owned so it runs with no client connected.
 * - Idle: Present threads with no activity for the timeout move to the destination (Later).
 * - Older threads: Present or Later threads with no activity for the age move to Done.
 * Both are on by default; neither ever moves running, queued, waiting, or snoozed threads.
 */
export const INYOSIRA_IDLE_TIMEOUT_MIN_MINUTES = 10;
export const INYOSIRA_IDLE_TIMEOUT_MAX_MINUTES = 24 * 60;
export const DEFAULT_INYOSIRA_IDLE_TIMEOUT_MINUTES = 10;

export const INYOSIRA_OLDER_THREADS_MIN_DAYS = 1;
export const INYOSIRA_OLDER_THREADS_MAX_DAYS = 30;
export const DEFAULT_INYOSIRA_OLDER_THREADS_DAYS = 1;

export const InyosiraIdleTimeoutMinutes = Schema.Int.check(
  Schema.isBetween({
    minimum: INYOSIRA_IDLE_TIMEOUT_MIN_MINUTES,
    maximum: INYOSIRA_IDLE_TIMEOUT_MAX_MINUTES,
  }),
);
export type InyosiraIdleTimeoutMinutes = typeof InyosiraIdleTimeoutMinutes.Type;

export const InyosiraOlderThreadsDays = Schema.Int.check(
  Schema.isBetween({
    minimum: INYOSIRA_OLDER_THREADS_MIN_DAYS,
    maximum: INYOSIRA_OLDER_THREADS_MAX_DAYS,
  }),
);
export type InyosiraOlderThreadsDays = typeof InyosiraOlderThreadsDays.Type;

/** Done is an organizational destination; it never claims the work succeeded. */
export const InyosiraIdleDestination = Schema.Literals(["done", "later"]);
export type InyosiraIdleDestination = typeof InyosiraIdleDestination.Type;

export const InyosiraIdleSettingsFields = {
  inyosiraIdleCleanupEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  inyosiraIdleTimeoutMinutes: InyosiraIdleTimeoutMinutes.pipe(
    Schema.withDecodingDefault(() => DEFAULT_INYOSIRA_IDLE_TIMEOUT_MINUTES),
  ),
  inyosiraIdleDestination: InyosiraIdleDestination.pipe(
    Schema.withDecodingDefault(() => "later" as const satisfies InyosiraIdleDestination),
  ),
  inyosiraOlderThreadsEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  inyosiraOlderThreadsDays: InyosiraOlderThreadsDays.pipe(
    Schema.withDecodingDefault(() => DEFAULT_INYOSIRA_OLDER_THREADS_DAYS),
  ),
};

export const InyosiraIdleSettingsPatchFields = {
  inyosiraIdleCleanupEnabled: Schema.optionalKey(Schema.Boolean),
  inyosiraIdleTimeoutMinutes: Schema.optionalKey(InyosiraIdleTimeoutMinutes),
  inyosiraIdleDestination: Schema.optionalKey(InyosiraIdleDestination),
  inyosiraOlderThreadsEnabled: Schema.optionalKey(Schema.Boolean),
  inyosiraOlderThreadsDays: Schema.optionalKey(InyosiraOlderThreadsDays),
};
