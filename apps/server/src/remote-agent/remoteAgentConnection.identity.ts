function shellQuote(value: string): string {
  if (/^\$HOME(?:\/[\w.+-]+)*$/.test(value)) return `"${value}"`;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function buildRemoteAgentIdentityProbeCommand(binaryPath: string): string {
  const binary = shellQuote(binaryPath);
  return `if test -x ${binary}; then exec ${binary} --check; else printf 'missing'; fi`;
}
