/** Fence both successful and failed startup requests after lifecycle recovery supersedes them. */
export function makeTerminalStartupRecovery(input: {
  open: (superseded: () => boolean, attachOnly: boolean) => Promise<boolean>;
  onFailure: (error: unknown) => void;
}) {
  let epoch = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const invalidate = () => {
    epoch++;
    clearTimeout(timer);
    timer = undefined;
  };
  const run = async (attachOnly = false): Promise<void> => {
    invalidate();
    const requestEpoch = epoch;
    const superseded = () => requestEpoch !== epoch;
    try {
      const opened = await input.open(superseded, attachOnly);
      if (!opened && !superseded()) {
        timer = setTimeout(() => void run(attachOnly), 50);
      }
    } catch (error) {
      if (!superseded()) input.onFailure(error);
    }
  };
  return { run, invalidate };
}
