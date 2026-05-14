import {
  DEFAULT_THREAD_TITLE as SHARED_DEFAULT_THREAD_TITLE,
  fallbackThreadTitleFromPrompt,
} from "@bigbud/shared/String";

export const DEFAULT_THREAD_TITLE = SHARED_DEFAULT_THREAD_TITLE;

export function draftTitleFromMessage(messageText: string): string {
  return fallbackThreadTitleFromPrompt(messageText);
}
