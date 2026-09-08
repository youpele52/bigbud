export const WINDOWS_SIGNING_CONFIGURATION_NAMES = [
  "WIN_CSC_LINK",
  "WIN_CSC_KEY_PASSWORD",
  "BIGBUD_WINDOWS_SIGNING_SUBJECT",
] as const;

const UNSIGNED_SIGNING_ENVIRONMENT_NAMES = [
  ...WINDOWS_SIGNING_CONFIGURATION_NAMES,
  "CSC_LINK",
  "CSC_KEY_PASSWORD",
  "CSC_NAME",
  "APPLE_API_KEY",
  "APPLE_API_KEY_ID",
  "APPLE_API_ISSUER",
] as const;

export interface WindowsSigningMode {
  readonly signed: boolean;
  readonly missing: ReadonlyArray<(typeof WINDOWS_SIGNING_CONFIGURATION_NAMES)[number]>;
}

export function resolveWindowsSigningMode(environment: NodeJS.ProcessEnv): WindowsSigningMode {
  const missing = WINDOWS_SIGNING_CONFIGURATION_NAMES.filter((name) => !environment[name]?.trim());
  return { signed: missing.length === 0, missing };
}

export function sanitizeUnsignedSigningEnvironment(environment: NodeJS.ProcessEnv): void {
  for (const name of UNSIGNED_SIGNING_ENVIRONMENT_NAMES) {
    delete environment[name];
  }
  environment.CSC_IDENTITY_AUTO_DISCOVERY = "false";
}

export function formatUnsignedWindowsWarning(missing: ReadonlyArray<string>): string {
  return `Windows artifacts will be unsigned because these settings are missing: ${missing.join(", ")}. Users may see Unknown Publisher and Microsoft Defender SmartScreen prompts.`;
}
