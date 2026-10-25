import type { MonitorNamedMetric } from "@bigbud/contracts/system-monitor/types";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { CenteredStatus } from "../common/CenteredStatus";
import { ResourceCpuCore } from "./ResourceCpuCore";

/** Preserve collector core order while adapting bar columns to the card's own available width. */
export function ResourceCpuCores({
  cores,
  active,
  loading,
}: {
  cores: readonly MonitorNamedMetric[];
  active: boolean;
  loading: boolean;
}) {
  return (
    <Card role="region" aria-label="CPU cores" className="@container min-w-0 gap-2 py-4">
      <CardHeader className="px-4">
        <CardTitle className="text-sm">CPU cores</CardTitle>
      </CardHeader>
      <CardContent className="min-w-0 px-4">
        {cores.length ? (
          <div
            data-slot="cpu-core-grid"
            className="grid min-w-0 grid-cols-1 gap-x-6 gap-y-3 @min-[640px]:grid-cols-2"
          >
            {cores.map((core) => (
              <ResourceCpuCore key={core.name} core={core} active={active} />
            ))}
          </div>
        ) : (
          <CenteredStatus loading={loading}>
            {loading ? "Waiting for core data" : "Core data unavailable"}
          </CenteredStatus>
        )}
      </CardContent>
    </Card>
  );
}
