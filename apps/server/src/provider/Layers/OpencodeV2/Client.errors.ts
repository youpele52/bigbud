/** Local HTTP metadata only; never retain a native response body or SDK request/cause. */
export class V2HttpStatusError extends Error {
  constructor(
    readonly status: number,
    operation = "request",
  ) {
    const label = /^[A-Za-z][A-Za-z0-9 ._-]{0,95}$/.test(operation) ? operation : "request";
    super(`OpenCode v2 ${label} returned HTTP ${status}; admission may be unconfirmed.`);
    this.name = "V2HttpStatusError";
  }
}

/** The pinned Promise client wraps fetch failures; recognize only our local classification. */
export function v2HttpFailureStatus(error: unknown): number | undefined {
  let current = error;
  for (let depth = 0; depth < 4; depth++) {
    if (
      current instanceof V2HttpStatusError &&
      Number.isInteger(current.status) &&
      current.status >= 400 &&
      current.status <= 599
    )
      return current.status;
    if (!(current instanceof Error)) return undefined;
    current = current.cause;
  }
  return undefined;
}
