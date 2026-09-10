export interface MobileRecoverySessionIdentity {
  readonly sessionId: string;
  readonly backendBaseUrl: string;
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
      previous.backendBaseUrl !== next.backendBaseUrl)
  ) {
    queryClient.removeQueries({ queryKey: ["mobile-snapshot", previous.sessionId] });
    queryClient.removeQueries({ queryKey: ["mobile-thread", previous.sessionId] });
  }
}
