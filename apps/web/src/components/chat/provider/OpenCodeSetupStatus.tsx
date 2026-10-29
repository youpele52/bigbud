import type { ServerOpencodeV2ThreadToolsSetupResult } from "@bigbud/contracts/server/server.opencodeV2ThreadToolsSetup";
import { useThreadNoticeDismissal } from "../../../stores/ui/threadNoticeDismissal.store";
import { CircleAlertIcon } from "lucide-react";
import { ChatBanner } from "../common/ChatBanner";
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
  const variant =
    error || result?.severity === "error"
      ? "error"
      : pending || result?.severity === "info"
        ? "info"
        : result?.severity === "warning"
          ? "warning"
          : result?.status === "ready"
            ? "success"
            : "warning";
  return (
    <section aria-label="OpenCode setup status" className="shrink-0">
      <ChatBanner
        role="status"
        variant={variant}
        icon={<CircleAlertIcon />}
        title={title}
        description={
          <>
            {result?.message ? (
              <span className="line-clamp-3" title={result.message}>
                {result.message}
              </span>
            ) : null}
            {error && error !== result?.message ? (
              <span role="alert" className="line-clamp-3 text-destructive" title={error}>
                {error}
              </span>
            ) : null}
            {pending ? (
              <span className="text-xs">
                Setup waits for known native work to finish. Retrying cannot bypass the idle gate;
                prompts are not replayed automatically.
              </span>
            ) : null}
          </>
        }
        dismissLabel="Dismiss OpenCode setup status"
        onDismiss={dismiss}
        action={
          <>
            <Button variant="outline" disabled={disabled || (pending && !error)} onClick={onRetry}>
              Retry setup
            </Button>
            {pending && result?.interestId ? (
              <Button variant="outline" disabled={disabled} onClick={onCancel}>
                Cancel this setup request
              </Button>
            ) : null}
          </>
        }
      />
    </section>
  );
}
