/** Count consecutive UTC activity days starting today, never yesterday. */
export function computeCurrentStreakDays(activeDays: readonly string[], now: Date): number {
  const days = new Set(activeDays);
  const cursor = new Date(now);
  cursor.setUTCHours(0, 0, 0, 0);
  let streak = 0;
  while (days.has(cursor.toISOString().slice(0, 10))) {
    streak += 1;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return streak;
}
