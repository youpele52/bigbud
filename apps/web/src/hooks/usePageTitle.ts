import { useEffect } from "react";

import { APP_BASE_NAME } from "../config/branding";

export function formatPageTitle(title?: string | null): string {
  const trimmedTitle = title?.trim();
  return trimmedTitle && trimmedTitle.length > 0
    ? `${trimmedTitle} | ${APP_BASE_NAME}`
    : APP_BASE_NAME;
}

export function usePageTitle(title?: string | null): void {
  useEffect(() => {
    document.title = formatPageTitle(title);
  }, [title]);
}
