import type { BackendScopeState } from "../../rpc/backendScope.state";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { remoteBackendWindowGuidance } from "./remoteBackendWindow.logic";

type BlockedState = Exclude<BackendScopeState, { kind: "local" } | { kind: "bound" }>;

/** Full-window status for a `?backend=` window that is binding, unavailable or refused. */
export function RemoteBackendWindowStatus({
  state,
  onRetry = () => window.location.reload(),
}: {
  readonly state: BlockedState;
  readonly onRetry?: () => void;
}) {
  const guidance = remoteBackendWindowGuidance(state);
  return (
    <main
      className="flex min-h-screen items-center justify-center bg-background p-6 text-sm text-foreground"
      data-backend-scope={state.kind}
    >
      <Alert variant={guidance.tone} className="max-w-md">
        <AlertTitle>{guidance.title}</AlertTitle>
        <AlertDescription>
          <p>{guidance.description}</p>
          <p className="text-xs text-muted-foreground">Backend profile: {state.profileId}</p>
          {guidance.retry ? (
            <Button size="sm" variant="outline" className="mt-2" onClick={onRetry}>
              Retry
            </Button>
          ) : null}
        </AlertDescription>
      </Alert>
    </main>
  );
}
