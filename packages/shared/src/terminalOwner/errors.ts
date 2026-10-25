/** Deliberately contains no input, credentials, profile paths or parse-error echo. */
export class TerminalOwnerContractError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "TerminalOwnerContractError";
  }
}
export function requireContract(condition: unknown, code: string): asserts condition {
  if (!condition) throw new TerminalOwnerContractError(code);
}
export function nextCounter(value: string): string {
  requireContract(
    /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) < 18446744073709551615n,
    "COUNTER_EXHAUSTED",
  );
  return (BigInt(value) + 1n).toString();
}
