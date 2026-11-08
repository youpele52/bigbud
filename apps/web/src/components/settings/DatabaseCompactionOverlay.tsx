import type { DatabaseCompactionStatus } from "@bigbud/contracts/server/databaseCompaction.ts";
import { createPortal } from "react-dom";

import { BigbudLoader } from "../layout/BigbudLoader";
import { getCompactionLoaderMessage } from "./DatabaseCompaction.logic";

/**
 * Covers the whole app while the database rebuilds: every other request waits behind `VACUUM`,
 * so nothing behind it would respond anyway.
 */
export function DatabaseCompactionOverlay({
  status,
  reconnecting,
}: {
  readonly status: DatabaseCompactionStatus | null;
  readonly reconnecting: boolean;
}) {
  const message = getCompactionLoaderMessage(status, reconnecting);
  return createPortal(
    <div
      className="fixed inset-0 z-[1000] flex flex-col bg-background"
      data-testid="database-compaction-overlay"
      aria-modal="true"
      role="dialog"
      aria-label={message.title}
    >
      <BigbudLoader className="flex-1" label={message.title} />
      <div className="pointer-events-none absolute inset-x-0 top-1/2 mt-10 flex justify-center px-6">
        <div className="max-w-sm space-y-1 text-center">
          <p className="text-sm font-medium text-foreground">{message.title}</p>
          <p className="text-xs text-muted-foreground">{message.detail}</p>
        </div>
      </div>
    </div>,
    document.body,
  );
}
