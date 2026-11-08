import { cn } from "~/lib/utils";
import { BigbudLoader } from "../layout/BigbudLoader";
import { Card, CardHeader } from "../ui/card";

/** Reserve a visualization-sized surface without blocking unrelated usage data. */
export function UsageSectionLoader({
  label,
  title,
  overview = false,
  activity = false,
}: {
  readonly label: string;
  readonly title?: string;
  readonly overview?: boolean;
  readonly activity?: boolean;
}) {
  return (
    <Card className="@container overflow-hidden">
      {title ? (
        <CardHeader>
          <h3>{title}</h3>
        </CardHeader>
      ) : null}
      <BigbudLoader
        label={label}
        className={cn(
          "h-auto flex-1",
          overview
            ? "min-h-80 @sm:min-h-44"
            : activity
              ? // Chart/header plus a stacked token-types pane with room for all five legend rows.
                "min-h-[53rem] lg:min-h-[27rem]"
              : "min-h-96",
        )}
      />
    </Card>
  );
}
