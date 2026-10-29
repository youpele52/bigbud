import { RotateCcw } from "lucide-react";
import React, { type ReactNode } from "react";

import { Button } from "../ui/button";

interface TerminalViewportErrorBoundaryProps {
  readonly terminalLabel: string;
  readonly children: ReactNode;
}

interface TerminalViewportErrorBoundaryState {
  readonly failed: boolean;
  /** Bumped by "Reload terminal view" to remount the viewport from scratch. */
  readonly generation: number;
}

/**
 * Contains a crash in one terminal view so it cannot unmount the chat around it. The view only
 * renders the emulator; reloading it reattaches to the running shell through `open`, which never
 * restarts a live process.
 */
export class TerminalViewportErrorBoundary extends React.Component<
  TerminalViewportErrorBoundaryProps,
  TerminalViewportErrorBoundaryState
> {
  override state: TerminalViewportErrorBoundaryState = { failed: false, generation: 0 };

  static getDerivedStateFromError(): Partial<TerminalViewportErrorBoundaryState> {
    return { failed: true };
  }

  override componentDidCatch(error: unknown): void {
    console.error(`[terminal] ${this.props.terminalLabel} view crashed`, error);
  }

  private readonly reload = () => {
    this.setState((state) => ({ failed: false, generation: state.generation + 1 }));
  };

  override render() {
    if (!this.state.failed) {
      return <React.Fragment key={this.state.generation}>{this.props.children}</React.Fragment>;
    }
    return (
      <div
        role="alert"
        className="flex h-full w-full flex-col items-center justify-center gap-3 p-4 text-center"
      >
        <div className="flex flex-col gap-1">
          <p className="text-sm text-foreground">This terminal view stopped unexpectedly.</p>
          <p className="text-xs text-muted-foreground">
            Reloading reattaches to the terminal session without restarting it.
          </p>
        </div>
        <Button variant="outline" onClick={this.reload}>
          <RotateCcw />
          Reload terminal view
        </Button>
      </div>
    );
  }
}
