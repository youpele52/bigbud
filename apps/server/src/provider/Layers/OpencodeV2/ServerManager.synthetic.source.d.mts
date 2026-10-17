export function verifyV2SyntheticSource(
  binary: string,
  profile: string,
): Promise<{ executable: string; prefix: string[] }>;
