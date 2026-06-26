import { APP_NAME, MARKETING_ASSETS } from "./app";

function formatPageTitle(title: string): string {
  return `${title} | ${APP_NAME}`;
}

function uniqueKeywords(...keywordGroups: string[][]): string[] {
  return [...new Set(keywordGroups.flat())];
}

const CORE_KEYWORDS = [
  "bigbud",
  "AI workspace",
  "AI app for everyone",
  "multi-provider AI workspace",
  "AI coding workspace",
  "desktop AI workspace",
  "AI workspace for work",
  "AI workspace for teams",
];

const PROVIDER_KEYWORDS = [
  "Codex",
  "Claude",
  "Copilot",
  "OpenCode",
  "KiloCode",
  "Devin",
  "Pi",
  "Cursor",
];

const MODEL_KEYWORDS = [
  "GPT-5.5",
  "GPT-5.4",
  "GPT-5.4 Mini",
  "GPT-5.3 Codex",
  "GPT-5 Mini",
  "Claude Sonnet 4.6",
  "Claude Opus 4.6",
  "Claude Haiku 4.5",
];

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
    "An AI workspace for everyone. It keeps your research, writing, coding, files, and git workflows in one place so you can stay focused and get more done with less context switching.",
  image: MARKETING_ASSETS.socialImagePath,
  imageAlt: "bigbud workspace preview",
  keywords: uniqueKeywords(CORE_KEYWORDS, PROVIDER_KEYWORDS, MODEL_KEYWORDS),
  type: "website",
} as const;

export const HOME_METADATA = {
  title: formatPageTitle("Your AI workspace for getting things done"),
  description:
    "An AI workspace for everyone. It keeps your research, writing, coding, files, and git workflows in one place so you can stay focused and get more done with less context switching.",
  image: MARKETING_ASSETS.socialImagePath,
  imageAlt: "bigbud workspace on desktop",
  keywords: uniqueKeywords(CORE_KEYWORDS, PROVIDER_KEYWORDS, MODEL_KEYWORDS, [
    "AI chat workspace",
    "AI browser workspace",
    "AI git workspace",
    "use your existing AI subscriptions",
    "AI workspace for everyone",
  ]),
} as const;

export const DOWNLOAD_METADATA = {
  title: formatPageTitle(`download ${APP_NAME} | macOS, Windows, Linux`),
  description: `Download ${APP_NAME} for macOS, Windows, or Linux and get your AI workspace running in minutes.`,
  image: MARKETING_ASSETS.socialImagePath,
  imageAlt: `${APP_NAME} download preview`,
  keywords: uniqueKeywords(CORE_KEYWORDS, PROVIDER_KEYWORDS, MODEL_KEYWORDS, [
    "download bigbud",
    "AI workspace for macOS",
    "AI workspace for Windows",
    "AI workspace for Linux",
  ]),
} as const;

export const CHANGELOG_METADATA = {
  title: formatPageTitle("changelog & release notes"),
  description: `Stay up to date with the latest ${APP_NAME} releases — new features, UX improvements, bug fixes, and product updates for your AI workspace.`,
  image: MARKETING_ASSETS.socialImagePath,
  imageAlt: `${APP_NAME} changelog preview`,
  keywords: uniqueKeywords(CORE_KEYWORDS, PROVIDER_KEYWORDS, MODEL_KEYWORDS, [
    "bigbud changelog",
    "bigbud release notes",
    "AI workspace updates",
    "AI app changelog",
  ]),
} as const;

export const DOCS_METADATA = {
  title: formatPageTitle(`getting started with ${APP_NAME}`),
  description: `Get up and running with ${APP_NAME} — install the app, connect your AI providers, start your first thread, and learn the key workflows.`,
  image: MARKETING_ASSETS.socialImagePath,
  imageAlt: `${APP_NAME} docs preview`,
  keywords: uniqueKeywords(CORE_KEYWORDS, PROVIDER_KEYWORDS, MODEL_KEYWORDS, [
    "bigbud docs",
    "bigbud getting started",
    "bigbud quick start",
    "bigbud tutorial",
    "AI workspace setup",
    "how to use bigbud",
  ]),
} as const;

export const GETTING_STARTED_METADATA = DOCS_METADATA;
