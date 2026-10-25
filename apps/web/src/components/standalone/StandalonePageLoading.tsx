import type { ReactNode } from "react";

import { BigbudLoader } from "../layout/BigbudLoader";

/** Keep data producers mounted while the startup logo fills the pending page body. */
export function StandalonePageLoading({
  loading,
  label,
  children,
}: {
  readonly loading: boolean;
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-slot="standalone-page-loading">
      {loading ? <BigbudLoader className="flex-1" label={label} /> : null}
      <div className={loading ? "hidden" : "contents"} inert={loading || undefined}>
        {children}
      </div>
    </div>
  );
}
