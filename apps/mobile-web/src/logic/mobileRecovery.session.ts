export interface MobileRecoverySessionIdentity {
  readonly sessionId: string;
  readonly backendBaseUrl: string;
  readonly stateScope?: string;
}

export function clearReplacedMobileSessionCaches(
  queryClient: { removeQueries: (input: { queryKey: ReadonlyArray<string> }) => unknown },
  previous: MobileRecoverySessionIdentity | null,
  next: MobileRecoverySessionIdentity | null,
) {
  if (
    previous !== null &&
    (next === null ||
      previous.sessionId !== next.sessionId ||
      previous.stateScope !== next.stateScope ||
      previous.backendBaseUrl !== next.backendBaseUrl)
  ) {
    queryClient.removeQueries({
      queryKey: ["mobile-snapshot", previous.stateScope ?? previous.sessionId],
    });
    queryClient.removeQueries({
      queryKey: ["mobile-thread", previous.stateScope ?? previous.sessionId],
    });
  }
}
