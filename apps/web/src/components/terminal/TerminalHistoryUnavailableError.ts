/** A healthy process can outlive an unavailable view baseline; never infer that it is dead. */
export class TerminalHistoryUnavailableError extends Error {
  constructor(reason?: string) {
    super(
      "Terminal history is unavailable. The process is still running, but its screen cannot be restored. Use an existing view or restart this terminal to start fresh." +
        (reason ? ` Recovery unavailable: ${reason}.` : ""),
    );
    this.name = "TerminalHistoryUnavailableError";
  }
}
