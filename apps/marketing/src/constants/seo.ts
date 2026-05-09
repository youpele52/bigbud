import { APP_NAME, MARKETING_ASSETS } from "./app";

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
  title: `${APP_NAME} | Your AI workspace for getting things done`,
  description:
    "An AI companion workspace for getting things done — whether you're coding, writing, analyzing, or exploring ideas. Built for developers and designed for everyone.",
  image: MARKETING_ASSETS.socialImagePath,
  imageAlt: "bigbud workspace on desktop",
} as const;

export const DOWNLOAD_METADATA = {
  title: `Download ${APP_NAME} | macOS, Windows, Linux`,
  description: `Download ${APP_NAME} for macOS, Windows, or Linux and get your AI workspace running in minutes.`,
  image: MARKETING_ASSETS.socialImagePath,
  imageAlt: `${APP_NAME} download preview`,
} as const;
