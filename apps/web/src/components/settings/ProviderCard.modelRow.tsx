import type { ServerProviderModel } from "@bigbud/contracts/server/server.providers.ts";
import { InfoIcon, XIcon } from "lucide-react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function ProviderModelRow({
  model,
  onRemoveCustomModel,
}: {
  model: ServerProviderModel;
  onRemoveCustomModel: (slug: string) => void;
}) {
  const caps = model.capabilities;
  const capLabels: string[] = [];
  if (caps?.supportsFastMode) capLabels.push("Fast mode");
  if (caps?.supportsThinkingToggle) capLabels.push("Thinking");
  if (caps?.reasoningEffortLevels && caps.reasoningEffortLevels.length > 0) {
    capLabels.push("Reasoning");
  }
  const hasDetails = capLabels.length > 0 || model.name !== model.slug;

  return (
    <div className="flex h-6 items-center gap-2 py-1">
      <span className="min-w-0 truncate text-xs text-foreground/90">{model.name}</span>
      {hasDetails ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                className="shrink-0 text-muted-foreground/40 transition-colors hover:text-muted-foreground"
                aria-label={`Details for ${model.name}`}
              />
            }
          >
            <InfoIcon className="size-3" />
          </TooltipTrigger>
          <TooltipPopup side="top" className="max-w-56">
            <div className="space-y-1">
              <span className="block break-all text-sm font-light text-foreground">
                {model.slug}
              </span>
              {capLabels.length > 0 ? (
                <div className="flex flex-wrap gap-x-2 gap-y-0.5">
                  {capLabels.map((label) => (
                    <span key={label} className="text-[10px] text-muted-foreground">
                      {label}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          </TooltipPopup>
        </Tooltip>
      ) : null}
      {model.isCustom ? (
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <span className="text-[10px] text-muted-foreground">custom</span>
          <button
            type="button"
            className="text-muted-foreground transition-colors hover:text-foreground"
            aria-label={`Remove ${model.slug}`}
            onClick={() => onRemoveCustomModel(model.slug)}
          >
            <XIcon className="size-3" />
          </button>
        </div>
      ) : null}
    </div>
  );
}
