import { useState } from "react";
import type { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { useStore } from "../../../stores/main/main.store";
import { Button } from "../../ui/button";
import {
  Dialog,
  DialogPopup,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "../../ui/dialog";
import { ContextWindowRecoveryActions } from "./ContextWindowRecoveryActions";
import { ProviderMcpControls } from "./ProviderMcpControls";
import { useProviderSessionControls } from "./useProviderSessionControls";
import { COMPACT_LABELS, compactTone } from "./ProviderSessionControls.logic";

/** Discoverable in every chat header; availability is supplied by the current server session. */
export function ProviderSessionControls({ threadId }: { threadId: ThreadId }) {
  const sessionEpoch = useStore(
    (state) => state.sidebarThreadsById[threadId]?.session?.sessionEpoch,
  );
  const [open, setOpen] = useState(false);
  const controls = useProviderSessionControls(threadId, sessionEpoch, open);
  const { snapshot, pending, error, request } = controls;
  const reason =
    snapshot?.compact.reason ?? "Requires the current live native session. Refresh availability.";
  const compactState = snapshot?.compactState ?? "idle";
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="xs" variant="toolbar" />} aria-label="Session controls">
        Session
      </DialogTrigger>
      <DialogPopup className="gap-3 overflow-y-auto p-5 text-sm">
        <DialogTitle className="text-sm font-medium">Session controls</DialogTitle>
        <DialogDescription className="text-xs">
          Native context maintenance and configured MCP servers for this chat. No session is
          automatically started or restarted.
        </DialogDescription>
        <Button
          size="sm"
          variant="outline"
          disabled={pending || sessionEpoch === undefined}
          onClick={() => void request("status")}
        >
          Refresh availability
        </Button>
        <section aria-label="Manual compaction" className="space-y-2">
          <h3 className="font-medium">Context compaction</h3>
          <ContextWindowRecoveryActions
            handoffAvailable={false}
            onUseHandoff={() => {}}
            compactAvailable={!!snapshot?.compact.available && !pending}
            compactReason={reason}
            onCompact={() => void request("compact")}
          />
          {reason && <p className="text-xs text-muted-foreground">{reason}</p>}
          <p role="status" className={compactTone(compactState)}>
            {COMPACT_LABELS[compactState]}
          </p>
        </section>
        <ProviderMcpControls
          snapshot={snapshot}
          pending={pending}
          onRefresh={() => void request("refresh-mcp")}
          onReload={() => void request("reload-mcp")}
        />
        {pending && (
          <p role="status" className="text-xs text-blue-600 dark:text-blue-400">
            Request in progress — acknowledgment is not compaction completion.
          </p>
        )}
        {snapshot?.message && (
          <p role="status" className="text-xs text-amber-600 dark:text-amber-400">
            {snapshot.message}
          </p>
        )}
        {error && (
          <p role="alert" className="text-xs text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
      </DialogPopup>
    </Dialog>
  );
}
