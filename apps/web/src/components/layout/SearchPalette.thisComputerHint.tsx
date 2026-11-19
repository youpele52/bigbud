import { useNavigate } from "@tanstack/react-router";
import { countUnicodeCodePoints } from "@bigbud/shared/String";

import { updateServerSettings, useSettings } from "~/hooks/useSettings";

import { Button } from "../ui/button";

/** The one-time hint (plan Q1) shows for 2+ character queries on macOS until acted on. */
export function shouldShowThisComputerHint(input: {
  readonly query: string;
  readonly mac: boolean;
  readonly thisComputer: boolean;
  readonly hasSeenHint: boolean;
}): boolean {
  return (
    input.mac &&
    !input.thisComputer &&
    !input.hasSeenHint &&
    countUnicodeCodePoints(input.query.trim()) >= 2
  );
}

/**
 * "Turn on search across this Mac". Turning it on needs File Access, so with File Access at
 * "No access" the button opens Settings › AI instead. Either choice hides the hint for good.
 */
export function SearchPaletteThisComputerHint({
  query,
  onNavigate,
}: {
  query: string;
  onNavigate: () => void;
}) {
  const navigate = useNavigate();
  const search = useSettings((settings) => settings.search);
  const mac = typeof navigator !== "undefined" && /mac/i.test(navigator.platform);
  if (
    !shouldShowThisComputerHint({
      query,
      mac,
      thisComputer: search.thisComputer,
      hasSeenHint: search.hasSeenThisComputerHint,
    })
  ) {
    return null;
  }
  const needsFileAccess = search.fileAccessLevel === "none";
  return (
    <div className="flex items-center gap-2 px-4 py-2 text-xs text-muted-foreground">
      <span className="min-w-0 flex-1">Search files across this Mac with Spotlight.</span>
      <Button
        size="xs"
        variant="outline"
        onClick={() => {
          if (needsFileAccess) {
            updateServerSettings({ search: { hasSeenThisComputerHint: true } });
            onNavigate();
            void navigate({ to: "/settings/ai" });
            return;
          }
          updateServerSettings({ search: { thisComputer: true, hasSeenThisComputerHint: true } });
        }}
      >
        {needsFileAccess ? "Set up" : "Turn on"}
      </Button>
      <Button
        size="xs"
        variant="ghost"
        onClick={() => updateServerSettings({ search: { hasSeenThisComputerHint: true } })}
      >
        Not now
      </Button>
    </div>
  );
}
