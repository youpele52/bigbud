/** Only terminal presentation and locale overrides cross an execution-host boundary. */
export function executionHostTerminalEnvironment(
  environment: NodeJS.ProcessEnv,
): ReadonlyArray<{ readonly name: string; readonly value: string }> {
  return Object.entries(environment).flatMap(([name, value]) =>
    value !== undefined && /^(TERM|COLORTERM|LANG|LC_[A-Z_]+)$/.test(name) ? [{ name, value }] : [],
  );
}
