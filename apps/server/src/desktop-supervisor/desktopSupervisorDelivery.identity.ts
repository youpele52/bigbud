export function hasLiveDesktopSupervisorSession(
  sessions: ReadonlyMap<string, { readonly closed: boolean }>,
  consumerId: string,
): boolean {
  return sessions.get(consumerId)?.closed === false;
}
