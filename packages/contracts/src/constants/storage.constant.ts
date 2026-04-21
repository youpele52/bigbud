/**
 * LocalStorage key for persisting composer drafts.
 *
 * Includes version suffix to allow for future migration strategies.
 */
export const COMPOSER_DRAFT_STORAGE_KEY = "bigbud:composer-drafts:v1";

/**
 * Legacy localStorage keys for composer drafts (migrated on first read).
 */
export const COMPOSER_DRAFT_LEGACY_STORAGE_KEYS = ["t3code:composer-drafts:v1"] as const;

/**
 * Current version of the composer draft storage schema.
 *
 * Increment this when making breaking changes to the storage format.
 * Migration logic should handle upgrading from older versions.
 */
export const COMPOSER_DRAFT_STORAGE_VERSION = 3;
