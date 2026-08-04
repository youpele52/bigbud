import * as Schema from "effect/Schema";

import { THREAD_ENV_MODES } from "../constants/settings.constant";

export const ThreadEnvMode = Schema.Literals(THREAD_ENV_MODES);
export type ThreadEnvMode = typeof ThreadEnvMode.Type;

export const AgentBrowserPreference = Schema.Literals(["bigbud", "system"]);
export type AgentBrowserPreference = typeof AgentBrowserPreference.Type;

export const COMPUTER_USE_CHECK_IN_INTERVAL_MS_MIN = 60_000;
export const COMPUTER_USE_CHECK_IN_INTERVAL_MS_MAX = 60 * 60_000;
export const DEFAULT_COMPUTER_USE_CHECK_IN_INTERVAL_MS = 10 * 60_000;
export const COMPUTER_USE_ACTION_TIMEOUT_MS_MIN = 10_000;
export const COMPUTER_USE_ACTION_TIMEOUT_MS_MAX = 60 * 60_000;
export const DEFAULT_COMPUTER_USE_ACTION_TIMEOUT_MS = 15 * 60_000;

export const ComputerUseCheckInIntervalMs = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(COMPUTER_USE_CHECK_IN_INTERVAL_MS_MIN),
).check(Schema.isLessThanOrEqualTo(COMPUTER_USE_CHECK_IN_INTERVAL_MS_MAX));

export const ComputerUseActionTimeoutMs = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(COMPUTER_USE_ACTION_TIMEOUT_MS_MIN),
).check(Schema.isLessThanOrEqualTo(COMPUTER_USE_ACTION_TIMEOUT_MS_MAX));
