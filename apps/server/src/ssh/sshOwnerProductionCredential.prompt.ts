/** The passphrase prompt text the web client parses (`apps/web/src/lib/ssh.ts`). */
export const buildSshKeyPassphraseRequiredMessage = (identity: string) =>
  `SSH key '${identity}' requires a passphrase. Enter it to unlock this target.`;
