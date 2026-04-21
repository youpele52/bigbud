/**
 * Available timestamp display formats.
 *
 * - `locale`: Use browser's locale format
 * - `12-hour`: 12-hour format with AM/PM
 * - `24-hour`: 24-hour military time format
 */
export const TIMESTAMP_FORMATS = ["locale", "12-hour", "24-hour"] as const;

/**
 * Default timestamp format.
 */
export const DEFAULT_TIMESTAMP_FORMAT = "locale" as const;

/**
 * Sidebar project sort order options.
 *
 * - `updated_at`: Most recently updated first
 * - `created_at`: Most recently created first
 * - `manual`: User-defined order
 */
export const SIDEBAR_PROJECT_SORT_ORDERS = ["updated_at", "created_at", "manual"] as const;

/**
 * Default sidebar project sort order.
 */
export const DEFAULT_SIDEBAR_PROJECT_SORT_ORDER = "updated_at" as const;

/**
 * Sidebar thread sort order options.
 *
 * - `updated_at`: Most recently updated first
 * - `created_at`: Most recently created first
 */
export const SIDEBAR_THREAD_SORT_ORDERS = ["updated_at", "created_at"] as const;

/**
 * Default sidebar thread sort order.
 */
export const DEFAULT_SIDEBAR_THREAD_SORT_ORDER = "updated_at" as const;

/**
 * Thread environment modes.
 *
 * - `local`: Thread runs in the main workspace
 * - `worktree`: Thread runs in an isolated git worktree
 */
export const THREAD_ENV_MODES = ["local", "worktree"] as const;
