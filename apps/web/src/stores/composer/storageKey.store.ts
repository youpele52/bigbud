import { COMPOSER_DRAFT_STORAGE_KEY } from "./types.store";

export const composerStorageKey =
  typeof window !== "undefined" && window.desktopBridge?.getWindowRole?.() === "compact-chat"
    ? "bigbud:compact-chat:composer-drafts:v1"
    : COMPOSER_DRAFT_STORAGE_KEY;
