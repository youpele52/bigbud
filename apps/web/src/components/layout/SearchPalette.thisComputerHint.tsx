import { useNavigate } from "@tanstack/react-router";
import { countUnicodeCodePoints } from "@bigbud/shared/String";

import { updateServerSettings, useSettings } from "~/hooks/useSettings";
import { currentOsIndexSource, osIndexWording } from "~/lib/osIndexWording";

import { Button } from "../ui/button";

/**
 * The one-time hint (plan Q1) shows for 2+ character queries on a platform with an OS index
 * (Spotlight, Windows Search or locate) until acted on, while
 * "this computer" is not searched: the setting is off, or (its default) on but File Access is
 * still "No access".
 */
export function shouldShowThisComputerHint(input: {
  readonly query: string;
  readonly supported: boolean;
  readonly thisComputer: boolean;
  readonly noFileAccess?: boolean;
  readonly hasSeenHint: boolean;
}): boolean {
  return (
    input.supported &&
    (!input.thisComputer || input.noFileAccess === true) &&
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
  const source = currentOsIndexSource();
  if (
    !shouldShowThisComputerHint({
      query,
      supported: source !== null,
      thisComputer: search.thisComputer,
      noFileAccess: search.fileAccessLevel === "none",
      hasSeenHint: search.hasSeenThisComputerHint,
    })
  ) {
    return null;
  }
  const needsFileAccess = search.fileAccessLevel === "none";
  return (
    <div className="flex items-center gap-2 px-4 py-2 text-xs text-muted-foreground">
      <span className="min-w-0 flex-1">
        Search files across {osIndexWording(source).place} with {osIndexWording(source).index}.
      </span>
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
