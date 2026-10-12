import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";

/** Shared rate layout keeps network and disk direction colors aligned with their graphs. */
export function ResourceTransferRates({
  incoming,
  outgoing,
  kind,
}: {
  incoming: string;
  outgoing: string;
  kind: "network" | "io";
}) {
  return (
    <div
      className="grid grid-cols-2 divide-x"
      role="group"
      aria-label={kind === "io" ? "I/O transfer rates" : "Network transfer rates"}
    >
      <div className="flex min-w-0 items-center gap-1.5 pr-3">
        <ArrowDownIcon className="size-4 shrink-0 text-(--chart-2)" aria-hidden="true" />
        <dl className="min-w-0">
          <dt className="text-xs text-muted-foreground">{kind === "io" ? "Read" : "Download"}</dt>
          <dd className="break-words text-sm font-semibold tabular-nums">{incoming}</dd>
        </dl>
      </div>
      <div className="flex min-w-0 items-center gap-1.5 pl-3">
        <ArrowUpIcon className="size-4 shrink-0 text-(--chart-4)" aria-hidden="true" />
        <dl className="min-w-0">
          <dt className="text-xs text-muted-foreground">{kind === "io" ? "Write" : "Upload"}</dt>
          <dd className="break-words text-sm font-semibold tabular-nums">{outgoing}</dd>
        </dl>
      </div>
    </div>
  );
}
