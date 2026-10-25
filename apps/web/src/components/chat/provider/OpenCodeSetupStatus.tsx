import type { ServerOpencodeV2ThreadToolsSetupResult } from "@bigbud/contracts/server/server.opencodeV2ThreadToolsSetup";
import { useThreadNoticeDismissal } from "../../../stores/ui/threadNoticeDismissal.store";
import { StatusBanner } from "../../common/StatusBanner";
import { Button } from "../../ui/button";
import { isPendingOpenCodeSetup } from "./opencodeSetup.observer";

/** Show actual activation work separately from passive native qualification warnings. */
export function OpenCodeSetupStatus({
  result,
  threadId = "opencode-setup",
  error,
  onRetry,
  onCancel,
  disabled = false,
}: {
  threadId?: string;
  result: ServerOpencodeV2ThreadToolsSetupResult | null | undefined;
  error?: string | null | undefined;
  onRetry: () => void;
  onCancel: () => void;
  disabled?: boolean;
}) {
  const { dismissed, dismiss } = useThreadNoticeDismissal(threadId, "opencode-setup-job", [
    result?.jobId,
  ]);
  if (dismissed || (!result && !error)) return null;
  const pending = !!result && isPendingOpenCodeSetup(result);
  const state = result?.activationState;
  const title = pending
    ? state === "waiting-for-idle"
      ? "OpenCode setup queued — waiting for idle"
      : `OpenCode setup — ${state}`
    : `OpenCode setup — ${state ?? result?.status ?? "status unavailable"}`;
  const tone =
    error || result?.severity === "error"
      ? "text-destructive"
      : pending
        ? "text-info"
        : result?.severity === "info"
          ? "text-info"
          : result?.severity === "warning"
            ? "text-warning"
            : result?.status === "ready"
              ? "text-success"
              : "text-warning";
  return (
    <section
      aria-label="OpenCode setup status"
      className={`space-y-2 border-b border-current/20 bg-current/5 px-4 py-3 text-sm ${tone}`}
    >
      <StatusBanner
        role="status"
        variant="default"
        title={title}
        description={result?.message}
        dismissLabel="Dismiss OpenCode setup status"
        onDismiss={dismiss}
      />
      {error ? <p role="alert">{error}</p> : null}
      {pending ? (
        <p className="text-xs text-muted-foreground">
          Setup waits for known native work to finish. Retrying cannot bypass the idle gate; prompts
          are not replayed automatically.
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={disabled || (pending && !error)} onClick={onRetry}>
          Retry setup
        </Button>
        {pending && result?.interestId ? (
          <Button variant="outline" disabled={disabled} onClick={onCancel}>
            Cancel this setup request
          </Button>
        ) : null}
      </div>
    </section>
  );
}
