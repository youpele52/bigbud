import * as Identity from "@bigbud/shared/machineIdentity";

/** Compatibility entry point for existing server consumers. */
export function machineIdentity(): string | null {
  return Identity.machineIdentity();
}

export function parseIoregPlatformUuid(output: string): string | undefined {
  return Identity.parseIoregPlatformUuid(output);
}
