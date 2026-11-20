/** Single-quotes one POSIX shell word; embedded quotes are closed, escaped and reopened. */
export function quoteShellArgument(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
