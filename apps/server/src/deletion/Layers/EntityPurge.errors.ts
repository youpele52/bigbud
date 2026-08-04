import { isPersistenceError, toPersistenceSqlError } from "../../persistence/Errors.ts";

export function mapPurgeError(operation: string) {
  return (error: unknown) =>
    isPersistenceError(error) ? error : toPersistenceSqlError(operation)(error);
}

export function nextPurgeRetryAt(attemptCount: number): string {
  const delay = Math.min(24 * 60 * 60 * 1_000, 15 * 60 * 1_000 * 2 ** attemptCount);
  return new Date(Date.now() + delay).toISOString();
}
