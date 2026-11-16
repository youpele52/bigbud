import type { ReactNode } from "react";

import { BigbudLogo } from "./BigbudLogo";
import { cn } from "../../lib/cn";

export function MobileStartupSplash({
  className = "",
  children,
}: {
  className?: string;
  /** Optional status shown beneath the logo, for example while a first connection keeps failing. */
  children?: ReactNode;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
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
        <BigbudLogo
          decorative
          className="h-7 animate-pulse-slow text-muted-foreground/50 motion-reduce:animate-none"
        />
        <span className="sr-only">Loading application</span>
        {children ? <div className="w-full max-w-sm px-4">{children}</div> : null}
      </div>
    </div>
  );
}
