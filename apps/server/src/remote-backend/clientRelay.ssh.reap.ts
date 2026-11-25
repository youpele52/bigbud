const CLIENT_RELAY_REAP_TIMEOUT_MS = 2500;

export async function waitForClientRelayReap(
  exited: Promise<void>,
  timeoutMs = CLIENT_RELAY_REAP_TIMEOUT_MS,
): Promise<void> {
  let deadline: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      exited,
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(
          () => reject(new Error("SSH relay cleanup could not confirm owned child exit.")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (deadline) clearTimeout(deadline);
  }
}
