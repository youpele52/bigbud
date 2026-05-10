import { APP_NAME, MARKETING_ASSETS } from "./app";

function formatPageTitle(title: string): string {
  return `${title} | ${APP_NAME}`;
}

export const MARKETING_THEME_COLOR = "#171717";
export const OG_LOCALE = "en_US";
export const TWITTER_CARD = "summary_large_image";

export const ROBOTS_CONTENT = {
  index: "index, follow",
  noindex: "noindex, nofollow",
} as const;

export const DEFAULT_METADATA = {
  title: APP_NAME,
  description:
    "An AI companion workspace for getting things done. Built for developers and designed for everyone.",
  image: MARKETING_ASSETS.socialImagePath,
  imageAlt: "bigbud workspace preview",
  type: "website",
} as const;

export const HOME_METADATA = {
  title: formatPageTitle("Your AI workspace for getting things done"),
  description:
    "An AI companion workspace for getting things done — whether you're coding, writing, analyzing, or exploring ideas. Built for developers and designed for everyone.",
  image: MARKETING_ASSETS.socialImagePath,
  imageAlt: "bigbud workspace on desktop",
} as const;

export const DOWNLOAD_METADATA = {
  title: formatPageTitle(`download ${APP_NAME} | macOS, Windows, Linux`),
  description: `Download ${APP_NAME} for macOS, Windows, or Linux and get your AI workspace running in minutes.`,
  image: MARKETING_ASSETS.socialImagePath,
  imageAlt: `${APP_NAME} download preview`,
} as const;

export const CHANGELOG_METADATA = {
  title: formatPageTitle("changelog"),
  description: `See notable ${APP_NAME} updates, releases, and product improvements in one place.`,
  image: MARKETING_ASSETS.socialImagePath,
  imageAlt: `${APP_NAME} changelog preview`,
} as const;
