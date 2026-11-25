// Minimum from the S0 profile/role inventory and S2–S4 gates. Evidence cannot edit this list.
const targets = [
  ["darwin", "arm64"],
  ["darwin", "x64"],
  ["linux", "arm64"],
  ["linux", "x64"],
  ["win32", "arm64"],
  ["win32", "x64"],
] as const;

type Target = (typeof targets)[number];
type Profile = "D" | "V-E" | "V-B" | "N" | "R";
type Inbox = "win10-22h2" | "win11" | null;

function targetSlots(profile: Profile, target: Target, artifact: string) {
  const [os, arch] = target;
  const inboxes: readonly Inbox[] =
    os === "win32" ? (arch === "x64" ? ["win10-22h2", "win11"] : ["win11"]) : [null];
  return inboxes.map(
    (inbox) =>
      ({
        id: [profile, os, arch, artifact, inbox].filter(Boolean).join("."),
        profile,
        os,
        arch,
        artifact,
        inbox,
        disposition: profile === "V-E" || profile === "V-B" ? "review-scope" : "required",
      }) as const,
  );
}

function excluded(id: string, profile: Profile) {
  return {
    id: `${profile}.${id}`,
    profile,
    os: null,
    arch: null,
    artifact: null,
    inbox: null,
    disposition: "excluded",
  } as const;
}

export const slots = [
  ...targetSlots("D", ["darwin", "arm64"], "dmg"),
  ...targetSlots("D", ["darwin", "x64"], "dmg"),
  ...targetSlots("D", ["linux", "x64"], "appimage"),
  ...targetSlots("D", ["win32", "x64"], "nsis"),
  ...targets.flatMap((target) => targetSlots("V-E", target, "electron-dev")),
  ...targets.flatMap((target) => targetSlots("V-B", target, "bun-dev")),
  ...targets.flatMap((target) =>
    ["node-web", "node-desktop"].flatMap((mode) => targetSlots("N", target, mode)),
  ),
  ...targetSlots("R", ["linux", "x64"], "signed-gnu-graph"),
  ...targetSlots("R", ["linux", "arm64"], "signed-gnu-graph"),
  excluded("no-linux-arm64-installer", "D"),
  excluded("no-win32-arm64-installer", "D"),
  excluded("outside-native-targets", "N"),
  excluded("linux-musl", "N"),
  excluded("linux-musl", "R"),
  excluded("non-linux", "R"),
];

export type Slot = (typeof slots)[number];

export const commonLanes = {
  provenance: "artifact-and-image-verification",
  "clean-install": "product-smoke",
  "upgrade-install": "product-smoke",
  "owner-start-reattach": "exclusive-owner-lifecycle",
  "bad-owner-inputs": "unavailable-local-work-no-fallback",
  "managed-launches": "launch-traces-conform",
  "legacy-retirement": "live-drain-and-entry-retirement",
  "legacy-writers": "quiesced-writers-no-late-db-mutation",
  "stale-write-fencing": "stale-epochs-rejected-without-mutation-or-teardown",
  "build-a-first": "migration-aware-release-floor",
  "pre-a-and-fresh-db": "migration-and-sticky-disconnect",
  "offline-rollback": "same-db-rollback-and-reupgrade",
  "pane-record-rollback": "drained-pane-stays-closed-uncertain-pane-blocks-rollback",
  "unsafe-rollback": "retirement-failure-refuses-switch",
  "too-old-rollback": "downgrade-refusal-no-db-edit",
  "consumer-parity": "reviewed-consumer-and-structural-inventory",
} as const;

export const windowsLanes = {
  "inbox-key": "qualified-auth",
  "inbox-login-password": "qualified-auth",
  "inbox-keyboard-interactive": "qualified-auth",
  "inbox-unqualified-password": "windowsPasswordUnsupported-before-collection",
  "inbox-conpty": "conpty-and-console-isolation",
} as const;

export function requiredLanes(slot: Slot, helper: boolean): Readonly<Record<string, string>> {
  return {
    ...commonLanes,
    ...(slot.inbox ? windowsLanes : {}),
    ...(helper ? { "native-askpass": "verified-helper-and-askpassUnavailable" } : {}),
    ...(slot.profile === "N" ? { "standalone-cli": "delegation-and-clean-node-closure" } : {}),
    ...(slot.profile === "R"
      ? {
          "shared-client": "authorized-shared-route-trace",
          "shared-client-admission": "denied-no-launch",
          "agent-and-pty": "account-and-configured-agent-trace",
          "foreign-base-pty": "denied-with-probe-accounting",
          coordinator: "authorized-pinned-peer-trace",
          "peer-authority": "denied-no-launch",
          "local-only-deploy": "denied-no-launch",
          "outbound-client-relay": "denied-no-launch",
          "provider-callback-authority": "denied-no-launch",
          "inbound-client-receiver": "non-initiator-trace",
          "inbound-peer-worker": "non-initiator-trace",
          "remote-agent-receiver": "non-initiator-trace",
          "mobile-viewer": "non-initiator-trace",
          "mobile-authority": "denied-no-launch",
        }
      : {
          "local-deploy": "authorized-initiation-trace",
          "local-client-relay": "authorized-initiation-trace",
          "local-peer-coordinator": "denied-no-launch",
        }),
  };
}

export function verificationModes(slot: Slot): readonly string[] {
  switch (slot.artifact) {
    case "dmg":
      return ["developer-id-notarized"];
    case "nsis":
      return ["authenticode", "approved-unsigned-release"];
    case "appimage":
      return ["verified-release-members"];
    case "signed-gnu-graph":
      return ["release-trusted-signed-graph"];
    case "node-web":
    case "node-desktop":
      return ["verified-node-distribution"];
    default:
      return ["verified-development-inputs"];
  }
}
