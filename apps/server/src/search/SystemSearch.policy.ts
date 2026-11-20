/**
 * Managed-device policy (plan §8): `BIGBUD_SEARCH_THIS_COMPUTER=0` forces "Search this computer"
 * off. The server then neither starts the local agent with `--os-index` nor queries it.
 */
export const THIS_COMPUTER_POLICY_ENV = "BIGBUD_SEARCH_THIS_COMPUTER";

export function isThisComputerSearchAllowedByPolicy(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return environment[THIS_COMPUTER_POLICY_ENV]?.trim() !== "0";
}
