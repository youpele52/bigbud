import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";

export interface NetworkRates {
  download: string;
  upload: string;
}

/** Pair each transfer rate with its direction and matching history color. */
export function ResourceNetworkRates({ rates }: { rates: NetworkRates }) {
  return (
    <div className="grid grid-cols-2 divide-x" role="group" aria-label="Network transfer rates">
      <div className="flex min-w-0 items-center gap-1.5 pr-3">
        <ArrowDownIcon className="size-4 shrink-0 text-(--chart-2)" aria-hidden="true" />
        <dl className="min-w-0">
          <dt className="text-xs text-muted-foreground">Download</dt>
          <dd className="break-words text-sm font-semibold tabular-nums">{rates.download}</dd>
        </dl>
      </div>
      <div className="flex min-w-0 items-center gap-1.5 pl-3">
        <ArrowUpIcon className="size-4 shrink-0 text-(--chart-4)" aria-hidden="true" />
        <dl className="min-w-0">
          <dt className="text-xs text-muted-foreground">Upload</dt>
          <dd className="break-words text-sm font-semibold tabular-nums">{rates.upload}</dd>
        </dl>
      </div>
    </div>
  );
}
