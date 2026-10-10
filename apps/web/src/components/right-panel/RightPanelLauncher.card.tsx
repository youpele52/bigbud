import { cn } from "~/lib/utils";
import { Kbd, KbdGroup } from "../ui/kbd";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { LauncherToolKind } from "./RightPanelLauncher";

interface LauncherCardProps {
  description: string;
  disabled?: boolean;
  icon: React.ComponentType<{ className?: string }>;
  kind: LauncherToolKind;
  label: string;
  onSelect: () => void;
  shortcutLabel: string | null;
}

export function LauncherCard({
  description,
  disabled = false,
  icon: Icon,
  label,
  onSelect,
  shortcutLabel,
}: LauncherCardProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            disabled={disabled}
            onClick={onSelect}
            className={cn(
              "group flex aspect-square flex-col items-center justify-center gap-3 rounded-2xl p-3 text-center transition-colors",
              disabled
                ? "cursor-not-allowed opacity-40"
                : "hover:bg-secondary/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            )}
          />
        }
      >
        <span className="flex size-16 items-center justify-center rounded-[1.25rem] border border-border/70 bg-secondary/60 shadow-sm transition-transform group-hover:scale-105 group-focus-visible:scale-105">
          <Icon className="size-7 text-foreground" />
        </span>
        <span className="text-xs font-medium text-foreground">{label}</span>
      </TooltipTrigger>
      <TooltipPopup className="px-3 py-2" side="top">
        <div className="flex items-center gap-3 whitespace-nowrap">
          <span>{description}</span>
          {shortcutLabel ? (
            <KbdGroup>
              <Kbd>{shortcutLabel}</Kbd>
            </KbdGroup>
          ) : null}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}
