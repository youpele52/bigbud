/** Keep the primary failure visible when owned fixture cleanup also fails. */
export function combinedCheckpointFailure(primary: unknown, cleanup: unknown, message: string) {
  return new AggregateError([primary, cleanup], message, { cause: primary });
}
