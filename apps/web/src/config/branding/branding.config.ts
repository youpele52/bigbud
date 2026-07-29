import { APP_BASE_NAME, APP_SERVER_NAME, APP_SERVER_SLUG } from "@bigbud/contracts";

export { APP_BASE_NAME, APP_SERVER_NAME, APP_SERVER_SLUG };
export const APP_VERSION = import.meta.env.APP_VERSION || "0.0.0";

const RELEASE_CHANNEL_LABELS = {
  beta: "Beta",
  preview: "Preview",
  nightly: "Nightly",
} as const;

type ReleaseChannel = keyof typeof RELEASE_CHANNEL_LABELS;

function resolveReleaseChannel(version: string): ReleaseChannel | null {
  const channel = /^\d+\.\d+\.\d+-(?<channel>[a-z]+)(?:[.-][0-9a-z.-]+)?$/i
    .exec(version.trim())
    ?.groups?.channel?.toLowerCase();
  return Object.hasOwn(RELEASE_CHANNEL_LABELS, channel ?? "") ? (channel as ReleaseChannel) : null;
}

export const APP_STAGE_LABEL = import.meta.env.DEV ? "Dev" : resolveReleaseChannel(APP_VERSION);
export const APP_DISPLAY_NAME = APP_STAGE_LABEL
  ? `${APP_BASE_NAME} (${APP_STAGE_LABEL === "Dev" ? APP_STAGE_LABEL : RELEASE_CHANNEL_LABELS[APP_STAGE_LABEL]})`
  : APP_BASE_NAME;
