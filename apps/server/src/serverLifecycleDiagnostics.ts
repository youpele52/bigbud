import { version } from "../package.json" with { type: "json" };

export interface ServerLifecycleDiagnosticProcess {
  readonly pid: number | undefined;
  readonly cwd: () => string;
  readonly on: (event: string, listener: (...args: any[]) => void) => unknown;
}

export function registerServerLifecycleDiagnostics(
  processRef: ServerLifecycleDiagnosticProcess = process,
  log: (message: string, details: Record<string, unknown>) => void = console.error,
): void {
  log("bigbud server startup", { version, pid: processRef.pid, cwd: processRef.cwd() });
  processRef.on("uncaughtExceptionMonitor", (error: Error, origin: string) => {
    log("bigbud server uncaught exception", { name: error.name, message: error.message, origin });
  });
  processRef.on("exit", (code: number) => {
    log("bigbud server exit", { code, pid: processRef.pid });
  });
}
