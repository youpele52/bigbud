import type { ReactNode } from "react";

import { cn } from "./lib/cn";

export function MobilePage({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("grid gap-3", className)}>{children}</div>;
}

export function MobileCard({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <section
      className={cn(
        "rounded-2xl border border-border bg-card p-4 text-card-foreground shadow-xs",
        className,
      )}
    >
      {children}
    </section>
  );
}

export function MobileEyebrow({ children }: { children: ReactNode }) {
  return (
    <p className="mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
      {children}
    </p>
  );
}

export function MobileTitle({ children }: { children: ReactNode }) {
  return <h2 className="text-sm font-semibold text-foreground">{children}</h2>;
}

export function MobileMuted({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p className={cn("text-xs leading-relaxed text-muted-foreground", className)}>{children}</p>
  );
}

export function MobileBadge({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full bg-success/15 px-2.5 py-1 text-xs font-medium text-success-foreground">
      {children}
    </span>
  );
}

export function MobileRow({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("flex items-start justify-between gap-3", className)}>{children}</div>;
}

export function MobileActions({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn("flex flex-wrap gap-2", className)}>{children}</div>;
}
