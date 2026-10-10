/** Exact preview client/CLI pair; this pin is not full release conformance approval. */
export const OPENCODE_V2_CLIENT_VERSION = "2.0.26";
export const OPENCODE_V2_PROVIDER = "opencodeV2";
export const OPENCODE_V2_DISPLAY_NAME = "OpenCode v2 (Preview)";

export function assertDevelopmentVersion(version: string): void {
  if (version !== OPENCODE_V2_CLIENT_VERSION) {
    throw new Error(
      `OpenCode v2 Preview requires CLI ${OPENCODE_V2_CLIENT_VERSION}; incompatible version rejected. Use a separate V2 executable and owned profile; V1 was not changed.`,
    );
  }
}

/** Never forward credentials to a readiness-supplied non-owned origin or redirect. */
export function validateOwnedEndpoint(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    Number(url.port) < 1 ||
    Number(url.port) > 65535 ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("OpenCode v2 readiness must advertise a loopback-only HTTP endpoint.");
  }
  return url.origin;
}

export const OPENCODE_V2_DORMANT_CAPABILITIES = {
  sessionModelSwitch: "unsupported",
  sessionRecovery: "unsupported",
  conversationRewind: "unsupported",
  conversationFork: "unsupported",
  supportsSteer: false,
  supportsAttachments: true,
  turnControl: {
    nativeSteer: false,
    interruptTarget: "current-session",
    activeTurnInspection: "unavailable",
    continuation: false,
  },
} as const;
