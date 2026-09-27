import { ArrowDownIcon, ArrowUpIcon, SlidersHorizontalIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import {
  RESOURCE_WIDGETS,
  useResourceWidgetPreferences,
  type ResourceWidget,
} from "~/stores/resource-monitor/resourceMonitorPreferences.store";

const LABELS: Record<ResourceWidget, string> = {
  cpu: "CPU",
  memory: "Memory",
  disk: "Disk",
  network: "Network",
  temperature: "Temperature",
};

export function WidgetPreferences() {
  const visible = useResourceWidgetPreferences((state) => state.visible);
  const toggle = useResourceWidgetPreferences((state) => state.toggle);
  const move = useResourceWidgetPreferences((state) => state.move);
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button variant="ghost" size="icon-sm" aria-label="Customize System widgets">
            <SlidersHorizontalIcon className="size-4" />
          </Button>
        }
      />
      <PopoverContent align="end" className="w-64 space-y-2 p-3">
        <p className="text-sm font-medium">System widgets</p>
        <p className="text-xs text-muted-foreground">
          Choose what appears in the panel and move visible widgets.
        </p>
        {RESOURCE_WIDGETS.map((widget) => {
          const index = visible.indexOf(widget);
          return (
            <div key={widget} className="flex items-center gap-2 text-sm">
              <label className="flex min-w-0 flex-1 items-center gap-2">
                <input
                  type="checkbox"
                  checked={index >= 0}
                  onChange={() => toggle(widget)}
                  className="accent-primary"
                />
                <span>{LABELS[widget]}</span>
              </label>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Move ${LABELS[widget]} up`}
                disabled={index <= 0}
                onClick={() => move(widget, -1)}
              >
                <ArrowUpIcon className="size-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Move ${LABELS[widget]} down`}
                disabled={index < 0 || index === visible.length - 1}
                onClick={() => move(widget, 1)}
              >
                <ArrowDownIcon className="size-3.5" />
              </Button>
            </div>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}
