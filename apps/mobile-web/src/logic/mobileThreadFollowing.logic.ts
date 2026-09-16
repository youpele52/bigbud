export const MOBILE_FOLLOW_BOTTOM_THRESHOLD_PX = 120;

export function shouldFollowMobileThreadContent(distanceFromBottom: number): boolean {
  return distanceFromBottom < MOBILE_FOLLOW_BOTTOM_THRESHOLD_PX;
}
