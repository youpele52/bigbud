import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";
import { cn } from "~/lib/utils";

/** Shared rate layout keeps network and disk direction colors aligned with their graphs. */
export function ResourceTransferRates({
  incoming,
  outgoing,
  kind,
  compact = false,
  centered = false,
}: {
  incoming: string;
  outgoing: string;
  kind: "network" | "io";
  compact?: boolean;
  centered?: boolean;
}) {
  return (
    <div
      className="grid w-full grid-cols-2 divide-x"
      role="group"
      aria-label={kind === "io" ? "I/O transfer rates" : "Network transfer rates"}
    >
      <div className={cn("flex min-w-0 items-center gap-1.5 pr-3", centered && "justify-center")}>
        <ArrowDownIcon
          className={cn("shrink-0 text-(--chart-2)", compact ? "size-3" : "size-4")}
          aria-hidden="true"
        />
        <dl className="min-w-0">
          <dt className="text-xs text-muted-foreground">{kind === "io" ? "Read" : "Download"}</dt>
          <dd
            className={cn(
              "break-words font-semibold tabular-nums",
              compact ? "text-xs" : "text-sm",
            )}
          >
            {incoming}
          </dd>
        </dl>
      </div>
      <div className={cn("flex min-w-0 items-center gap-1.5 pl-3", centered && "justify-center")}>
        <ArrowUpIcon
          className={cn("shrink-0 text-(--chart-4)", compact ? "size-3" : "size-4")}
          aria-hidden="true"
        />
        <dl className="min-w-0">
          <dt className="text-xs text-muted-foreground">{kind === "io" ? "Write" : "Upload"}</dt>
          <dd
            className={cn(
              "break-words font-semibold tabular-nums",
              compact ? "text-xs" : "text-sm",
            )}
          >
            {outgoing}
          </dd>
        </dl>
      </div>
    </div>
  );
}
