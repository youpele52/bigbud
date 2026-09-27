import { useState } from "react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";

export interface DisplayProcess {
  pid: number;
  name: string;
  status: string;
  cpu: string;
  memory: string;
  startTime: string;
  details: readonly [string, string][];
}

export interface ProcessQueryControls {
  search: string;
  status: string;
  sort: "cpu" | "memory" | "name" | "pid";
  descending: boolean;
}

export function ProcessTable({
  rows,
  controls,
  onControlsChange,
  onNextPage,
  onPreviousPage,
  hasNextPage,
  hasPreviousPage,
  status,
  truncated,
}: {
  rows: readonly DisplayProcess[];
  controls: ProcessQueryControls;
  onControlsChange: (next: ProcessQueryControls) => void;
  onNextPage: () => void;
  onPreviousPage: () => void;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  status: string;
  truncated: boolean;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const selectedRow = rows.find((row) => `${row.pid}:${row.startTime}` === selected);

  return (
    <Card className="gap-3 py-4">
      <CardHeader className="px-4">
        <CardTitle className="text-sm">Processes</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 px-4">
        <div className="flex flex-wrap gap-2">
          <Input
            aria-label="Search processes by name or PID"
            placeholder="Search name or PID"
            value={controls.search}
            maxLength={256}
            onChange={(event) => onControlsChange({ ...controls, search: event.target.value })}
            className="min-w-44 flex-1"
          />
          <Input
            aria-label="Filter process status"
            placeholder="Status"
            value={controls.status}
            maxLength={256}
            onChange={(event) => onControlsChange({ ...controls, status: event.target.value })}
            className="w-28"
          />
          <select
            aria-label="Sort processes"
            className="h-9 rounded-md border bg-background px-2 text-sm"
            value={controls.sort}
            onChange={(event) =>
              onControlsChange({
                ...controls,
                sort: event.target.value as ProcessQueryControls["sort"],
              })
            }
          >
            <option value="cpu">CPU</option>
            <option value="memory">Memory</option>
            <option value="name">Name</option>
            <option value="pid">PID</option>
          </select>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onControlsChange({ ...controls, descending: !controls.descending })}
            aria-label={controls.descending ? "Sort ascending" : "Sort descending"}
          >
            {controls.descending ? "Descending" : "Ascending"}
          </Button>
        </div>
        {status !== "ready" ? (
          <p className="text-xs capitalize text-muted-foreground">{status.replaceAll("_", " ")}</p>
        ) : null}
        {truncated ? (
          <p className="text-xs text-amber-600">
            Process inventory was capped. Refine the search to narrow results.
          </p>
        ) : null}
        <div className="max-h-80 overflow-auto rounded-md border">
          <table className="w-full min-w-[30rem] text-left text-sm">
            <thead className="sticky top-0 bg-muted text-xs text-muted-foreground">
              <tr>
                <th className="px-2 py-1.5">Name</th>
                <th className="px-2 py-1.5">PID</th>
                <th className="px-2 py-1.5">CPU</th>
                <th className="px-2 py-1.5">Memory</th>
                <th className="px-2 py-1.5">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.pid}:${row.startTime}`} className="border-t">
                  <td className="max-w-44 truncate px-2 py-1.5">
                    <button
                      type="button"
                      className="text-left underline-offset-2 hover:underline focus-visible:underline"
                      onClick={() => setSelected(`${row.pid}:${row.startTime}`)}
                    >
                      {row.name}
                    </button>
                  </td>
                  <td className="px-2 py-1.5 tabular-nums">{row.pid}</td>
                  <td className="px-2 py-1.5 tabular-nums">{row.cpu}</td>
                  <td className="px-2 py-1.5 tabular-nums">{row.memory}</td>
                  <td className="px-2 py-1.5">{row.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 ? (
            <p className="px-2 py-4 text-center text-xs text-muted-foreground">
              No processes to show
            </p>
          ) : null}
        </div>
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="outline" disabled={!hasPreviousPage} onClick={onPreviousPage}>
            Previous
          </Button>
          <Button size="sm" variant="outline" disabled={!hasNextPage} onClick={onNextPage}>
            Next
          </Button>
        </div>
        {selectedRow ? (
          <div className="rounded-md border bg-muted/30 p-3 text-xs">
            <div className="mb-2 flex items-center justify-between">
              <strong className="text-sm">
                {selectedRow.name} · {selectedRow.pid}
              </strong>
              <Button size="xs" variant="ghost" onClick={() => setSelected(null)}>
                Close
              </Button>
            </div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
              {selectedRow.details.map(([label, value]) => (
                <div key={label} className="contents">
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="break-all">{value}</dd>
                </div>
              ))}
            </dl>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
