/** Release partially acquired view resources without hiding the original setup failure. */
export class TerminalSetupCleanup {
  private cleanups: Array<() => void> = [];

  add(cleanup: () => void): void {
    this.cleanups.push(cleanup);
  }

  dispose(): void {
    const cleanups = this.cleanups;
    this.cleanups = [];
    for (const cleanup of cleanups.toReversed()) {
      try {
        cleanup();
      } catch {
        // One broken disposer must not retain the remaining resources.
      }
    }
  }
}
