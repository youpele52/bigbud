import { SlidersHorizontalIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import {
  RESOURCE_DETAILS,
  useResourceDetailPreferences,
  type ResourceDetail,
} from "~/stores/resource-monitor/resourceMonitorDetails.store";

const LABELS: Record<ResourceDetail, string> = {
  ipAddress: "IP address",
  hostDetails: "Host details",
  hostExtras: "Host extras",
  disks: "Disk details",
  interfaces: "Network interfaces",
  cores: "CPU cores",
  memory: "Memory and swap",
  temperatures: "Temperatures",
  processes: "Processes",
};

export function ResourceDetailPreferences() {
  const visible = useResourceDetailPreferences((state) => state.visible);
  const toggle = useResourceDetailPreferences((state) => state.toggle);

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button variant="outline" size="sm" aria-label="Customize resource details">
            <SlidersHorizontalIcon className="size-4" /> Details
          </Button>
        }
      />
      <PopoverContent align="end" className="w-64 p-3">
        <div className="space-y-3">
          <p className="text-sm font-medium">Resource details</p>
          <p className="text-xs text-muted-foreground">
            Choose which details appear in the resource monitor.
          </p>
        </div>
        <div className="mt-4 space-y-2">
          {RESOURCE_DETAILS.map((detail) => (
            <label key={detail} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={visible.includes(detail)}
                onChange={() => toggle(detail)}
                className="accent-primary"
              />
              <span>{LABELS[detail]}</span>
            </label>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
