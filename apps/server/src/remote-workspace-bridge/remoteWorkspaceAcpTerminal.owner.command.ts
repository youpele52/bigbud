/**
 * U21 ACP shell grant: the exact command text an approval is bound to. ACP
 * `terminal/create` carries a command and optional args; args are appended
 * POSIX-quoted so the owner's shell receives one bounded text, never argv. The
 * fixed `pwd` recipe (no args, no environment) stays its own operation.
 *
 * @module remoteWorkspaceAcpTerminal.owner.command
 */
const MAX_COMMAND_BYTES = 64 * 1024;

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

export function acpCommandText(command: string, args: ReadonlyArray<string> = []): string {
  return [command, ...args.map(quote)].join(" ");
}

/** True for the unchanged fixed `pwd` recipe. */
export function isAcpPwdRequest(input: {
  readonly command: string;
  readonly args?: ReadonlyArray<string> | undefined;
  readonly environment?: ReadonlyArray<unknown> | undefined;
}): boolean {
  return input.command === "pwd" && !input.args?.length && !input.environment?.length;
}

/** A shell command text the owner admits: non-empty, bounded, no NUL. */
export function isAdmissibleAcpShellText(text: string): boolean {
  return (
    text.trim().length > 0 && !text.includes("\0") && Buffer.byteLength(text) <= MAX_COMMAND_BYTES
  );
}
