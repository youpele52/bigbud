function shellQuote(value: string): string {
  if (/^\$HOME(?:\/[\w.+-]+)*$/.test(value)) return `"${value}"`;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Observe canonical bytes without sourcing startup files or preparing a supervisor. */
export function buildRemoteAgentRuntimeProbeCommand(binaryPath: string): string {
  return `set -eu
binary=${shellQuote(binaryPath)}
if test ! -x "$binary"; then printf missing; exit 0; fi
readlink -f -- "$binary"
sha256sum -- "$binary" | cut -d ' ' -f1
"$binary" --check
`;
}

export function buildRemoteAgentIdentityProbeCommand(binaryPath: string): string {
  const binary = shellQuote(binaryPath);
  return `if test -x ${binary}; then exec ${binary} --check; else printf 'missing'; fi`;
}
