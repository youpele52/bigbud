import { compareCodexCliVersions } from "../provider/codexCliVersion";

/**
 * Codex offers `request_user_input` only in Plan mode unless the `default_mode_request_user_input`
 * feature is on. bigbud verified the flag on Codex CLI 0.167.0 (a Default-mode turn asked through
 * the tool and accepted the answer; without the flag it fell back to a plain-text question).
 * Older or unknown versions keep today's behaviour, so they never see an unrecognized-setting
 * warning for a feature they lack.
 */
export const CODEX_DEFAULT_MODE_USER_INPUT_MIN_VERSION = "0.167.0";
const CODEX_DEFAULT_MODE_USER_INPUT_FEATURE = "features.default_mode_request_user_input=true";

export function supportsCodexDefaultModeUserInput(version: string | undefined): boolean {
  // Unparsable versions would fall back to string comparison, so require x.y.z first.
  return (
    version !== undefined &&
    /^\d+\.\d+\.\d+/.test(version) &&
    compareCodexCliVersions(version, CODEX_DEFAULT_MODE_USER_INPUT_MIN_VERSION) >= 0
  );
}

/** `app-server` config overrides that enable Default-mode questions where supported. */
export function codexQuestionToolConfigArgs(version: string | undefined): ReadonlyArray<string> {
  return supportsCodexDefaultModeUserInput(version)
    ? ["-c", CODEX_DEFAULT_MODE_USER_INPUT_FEATURE]
    : [];
}
