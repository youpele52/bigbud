export interface NewThreadActivationOptions {
  shouldActivate?: (() => boolean) | undefined;
}

export async function activateNewThreadRoute(input: {
  activation?: NewThreadActivationOptions | undefined;
  navigate: () => Promise<unknown>;
}): Promise<boolean> {
  if (input.activation?.shouldActivate?.() === false) return false;
  await input.navigate();
  return true;
}
