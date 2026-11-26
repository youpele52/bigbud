export interface DirectSshTerminalCwdRequest {
  readonly executionTargetId: string;
  readonly cwd: string;
  /** On a Home request, resolve the same SSH user's Home instead of probing cwd. */
  readonly home: boolean;
}

export type DirectSshTerminalCwdResult =
  | { readonly kind: "resolved"; readonly cwd: string }
  | { readonly kind: "noFolder" };

/** One noninteractive cwd inspection, not shell execution or terminal ownership. */
export interface DirectSshTerminalCwdOwner {
  /**
   * The owner verifies the exact target and authorizes the path, with an 8 KiB probe
   * output limit. Honor cancellation and reject admission, authentication, transport,
   * and timeout failures. Only report noFolder for a verified inaccessible directory.
   */
  readonly probeCwd: (
    request: DirectSshTerminalCwdRequest,
    signal: AbortSignal,
  ) => Promise<DirectSshTerminalCwdResult>;
}
