export function registerDesktopShutdownSignals(
  prepareForAppQuit: (reason: string) => void,
  quit: () => void,
): void {
  if (process.platform === "win32") return;

  process.on("SIGINT", () => {
    prepareForAppQuit("SIGINT");
    quit();
  });

  process.on("SIGTERM", () => {
    prepareForAppQuit("SIGTERM");
    quit();
  });
}
