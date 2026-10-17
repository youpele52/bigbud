/** Recovery requires an explicit process restart, not another snapshot of the same missing baseline. */
export class TerminalHistoryUnavailableError extends Error {
  constructor() {
    super(
      "Terminal history is unavailable. The process is still running, but its screen cannot be restored. Use an existing view or restart this terminal to start fresh.",
    );
    this.name = "TerminalHistoryUnavailableError";
  }
}
