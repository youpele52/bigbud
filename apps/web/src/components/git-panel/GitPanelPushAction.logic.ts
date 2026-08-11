export function getGitPanelPushLabel(aheadCount: number) {
  return aheadCount === 1 ? "Push commit" : `Push ${aheadCount} commits`;
}
