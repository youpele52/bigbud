import { BigbudLogo } from "../sidebar/SidebarProjectItem";
import { Button } from "../ui/button";
import type { BrowserNavigationErrorContent } from "./BrowserPanel.navigationError";

export function BrowserPanelErrorPage({
  content,
  onReload,
  onGoBack,
  onVisitAnyway,
}: {
  content: BrowserNavigationErrorContent;
  onReload: () => void;
  onGoBack?: (() => void) | undefined;
  onVisitAnyway?: (() => void) | undefined;
}) {
  return (
    <div
      className="absolute inset-0 z-10 overflow-auto bg-background px-6 py-10 text-foreground sm:px-10"
      role="alert"
      aria-live="assertive"
    >
      <div className="mx-auto flex min-h-full max-w-xl flex-col justify-center gap-4 pb-8">
        <span aria-hidden="true">
          <BigbudLogo className="h-6 animate-[breathe_1.2s_ease-in-out_infinite] text-muted-foreground/30 motion-reduce:animate-none" />
        </span>
        <h1 className="text-lg font-semibold">{content.title}</h1>
        <p className="text-sm text-muted-foreground">{content.description}</p>
        <div className="text-sm text-muted-foreground">
          <p>Try:</p>
          <ul className="list-disc space-y-1 pl-5">
            {content.suggestions.map((suggestion) => (
              <li key={suggestion}>{suggestion}</li>
            ))}
          </ul>
        </div>
        <p className="text-xs text-muted-foreground">{content.technicalCode}</p>
        <div className="flex flex-wrap gap-2 pt-2">
          <Button onClick={onReload}>Reload</Button>
          {onGoBack && (
            <Button variant="outline" onClick={onGoBack}>
              Go back
            </Button>
          )}
          {onVisitAnyway && (
            <Button variant="outline" onClick={onVisitAnyway}>
              Visit anyway
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
