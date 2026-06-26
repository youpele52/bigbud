import { BigbudLogo } from "./BigbudLogo";
import { cn } from "../lib/cn";

export function MobileStartupSplash({ className = "" }: { className?: string }) {
  return (
    <div
      className={cn(
        "relative flex min-h-screen items-center justify-center overflow-hidden bg-background text-foreground",
        className,
      )}
    >
      <div className="pointer-events-none absolute inset-0 opacity-90">
        <div className="absolute inset-x-0 top-0 h-56 bg-[radial-gradient(48rem_18rem_at_top,color-mix(in_srgb,var(--foreground)_8%,transparent),transparent)]" />
        <div className="absolute inset-0 bg-[linear-gradient(145deg,color-mix(in_srgb,var(--background)_94%,var(--color-black))_0%,var(--background)_58%)]" />
      </div>

      <div className="relative flex flex-col items-center justify-center gap-4">
        <BigbudLogo className="h-7 animate-pulse-slow text-muted-foreground/50" />
        <span className="sr-only">Loading application</span>
      </div>
    </div>
  );
}
