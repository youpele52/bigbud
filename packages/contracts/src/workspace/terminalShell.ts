import * as Schema from "effect/Schema";

/** Bounded identifiers, never executable command strings or connection URLs. */
export const ShellHostId = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/),
);
export const TerminalShellProfileId = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/),
);
const ShellText = Schema.String.check(Schema.isNonEmpty()).check(
  // oxlint-disable-next-line no-control-regex -- Reject control-bearing executable identities.
  Schema.isPattern(/^[^\x00-\x1f\x7f-\x9f\u{2028}\u{2029}]+$/u),
);
const ShellLabel = ShellText.check(Schema.isMaxLength(128));
const ShellExecutable = ShellText.check(Schema.isMaxLength(4096));
const ShellArgument = Schema.String.check(Schema.isMaxLength(4096)).check(
  // oxlint-disable-next-line no-control-regex -- Launch arguments must not contain NUL/newlines.
  Schema.isPattern(/^[^\u0000\r\n]*$/),
);

export const ShellHostScope = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("local"), hostId: ShellHostId }),
  Schema.Struct({ kind: Schema.Literal("ssh"), hostId: ShellHostId }),
  Schema.Struct({ kind: Schema.Literal("agent"), hostId: ShellHostId }),
  Schema.Struct({
    kind: Schema.Literal("wsl"),
    hostId: ShellHostId,
    distribution: ShellLabel,
    username: ShellLabel,
  }),
]);
export type ShellHostScope = typeof ShellHostScope.Type;

export const TerminalShellKind = Schema.Literals([
  "zsh",
  "bash",
  "fish",
  "pwsh",
  "windows-powershell",
  "cmd",
  "other",
]);
export type TerminalShellKind = typeof TerminalShellKind.Type;

/** Only a discovered identity can be selected; clients cannot supply executable/argv. */
export const ShellSelection = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("legacy-auto") }),
  Schema.Struct({ kind: Schema.Literal("profile"), profileId: TerminalShellProfileId }),
]);
export type ShellSelection = typeof ShellSelection.Type;

export const ShellIntegrationStatus = Schema.Struct({
  status: Schema.Literals([
    "probing",
    "qualified-history",
    "native-managed",
    "disabled",
    "unavailable",
    "unknown",
  ]),
  reason: Schema.optional(
    Schema.Literals([
      "policy-off",
      "not-qualified",
      "unsupported-shell",
      "native-owner",
      "custom-bindings",
      "missing-prerequisite",
      "control-unavailable",
      "incompatible-version",
    ]),
  ),
});
export type ShellIntegrationStatus = typeof ShellIntegrationStatus.Type;

/** Inventory only. The execution host must resolve and revalidate it before spawn. */
export const TerminalShellProfile = Schema.Struct({
  profileId: TerminalShellProfileId,
  host: ShellHostScope,
  kind: TerminalShellKind,
  displayName: ShellLabel,
  executable: ShellExecutable,
  args: Schema.Array(ShellArgument).check(Schema.isMaxLength(32)),
  platform: Schema.Literals(["win32", "darwin", "linux", "other"]),
  availability: Schema.Literals(["available", "unavailable"]),
  integration: ShellIntegrationStatus,
});
export type TerminalShellProfile = typeof TerminalShellProfile.Type;

/** Exact requested profile, not evidence that the executable started or remains running. */
export const ShellLaunchIntent = Schema.Struct({
  host: ShellHostScope,
  profileId: TerminalShellProfileId,
  kind: TerminalShellKind,
});
export type ShellLaunchIntent = typeof ShellLaunchIntent.Type;

/** Owned launch without qualified exec proof. Never use this for implicit inheritance. */
export const ShellUnconfirmedLaunch = Schema.Struct({
  status: Schema.Literal("unconfirmed"),
  requestedProfile: ShellLaunchIntent,
});
export type ShellUnconfirmedLaunch = typeof ShellUnconfirmedLaunch.Type;

/** Absent on old snapshots: do not infer a surviving shell from today's defaults. */
export const ShellLaunchIdentity = Schema.Struct({
  host: ShellHostScope,
  selection: ShellSelection,
  profileId: Schema.NullOr(TerminalShellProfileId),
  kind: TerminalShellKind,
  integration: ShellIntegrationStatus,
});
export type ShellLaunchIdentity = typeof ShellLaunchIdentity.Type;
