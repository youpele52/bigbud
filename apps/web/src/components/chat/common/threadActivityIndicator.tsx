import { cn } from "~/lib/utils";

export type ThreadActivityIndicatorTone = "running" | "compacting";

export function isSessionCompacting(
  session: { reason?: string | null; orchestrationStatus?: string | null } | null | undefined,
): boolean {
  return session?.orchestrationStatus === "running" && session.reason === "context.compacting";
}

export function threadActivityLabel(tone: ThreadActivityIndicatorTone): string {
  return tone === "compacting" ? "Compacting context" : "Agent is working";
}

export function ThreadActivityDots({
  tone,
  dotClassName,
}: {
  tone: ThreadActivityIndicatorTone;
  dotClassName?: string;
}) {
  const baseDotClassName = cn(
    "animate-pulse rounded-full",
    tone === "compacting" ? "bg-warning" : "bg-info-foreground",
    dotClassName,
  );

  return (
    <>
      <span aria-hidden="true" className={baseDotClassName} />
      <span aria-hidden="true" className={cn(baseDotClassName, "[animation-delay:200ms]")} />
      <span aria-hidden="true" className={cn(baseDotClassName, "[animation-delay:400ms]")} />
    </>
  );
}
