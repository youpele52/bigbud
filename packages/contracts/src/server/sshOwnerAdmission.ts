import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "../core/baseSchemas";

/** Additive server RPC names for the W3.6 fenced-startup drain action (U8). */
export const SSH_OWNER_ADMISSION_WS_METHODS = {
  get: "server.getSshOwnerAdmission",
  drain: "server.drainSshOwnerIdentifiedPanes",
} as const;

/** One managed SSH pane still running on a previous terminal host. */
export const SshOwnerFencedPane = Schema.Struct({
  identity: TrimmedNonEmptyString.check(Schema.isMaxLength(600)),
  threadId: Schema.String.check(Schema.isMaxLength(256)),
  paneId: Schema.String.check(Schema.isMaxLength(256)),
});
export type SshOwnerFencedPane = typeof SshOwnerFencedPane.Type;

/**
 * `fenced` is `legacyEntryFenced`: SSH is closed until the identified panes drain.
 * `unavailable` is `sshOwnerUnavailable`; it has no drain action.
 */
export const SshOwnerAdmissionSnapshot = Schema.Union([
  Schema.Struct({ state: Schema.Literals(["inactive", "open"]) }),
  Schema.Struct({
    state: Schema.Literal("fenced"),
    reason: Schema.Literals(["retirement-marker-missing", "legacy-panes-pending"]),
    message: Schema.String.check(Schema.isMaxLength(1024)),
    panes: Schema.Array(SshOwnerFencedPane).check(Schema.isMaxLength(256)),
    /** Set when the host inventory could not be read; the drain will refuse too. */
    listError: Schema.optional(Schema.String.check(Schema.isMaxLength(1024))),
  }),
  Schema.Struct({
    state: Schema.Literal("unavailable"),
    reason: Schema.String.check(Schema.isMaxLength(128)),
    message: Schema.String.check(Schema.isMaxLength(1024)),
  }),
]);
export type SshOwnerAdmissionSnapshot = typeof SshOwnerAdmissionSnapshot.Type;

export class SshOwnerDrainError extends Schema.TaggedErrorClass<SshOwnerDrainError>()(
  "SshOwnerDrainError",
  {
    code: Schema.Literals([
      "no-fence",
      "legacy-panes-pending",
      "host-exit-required",
      "conflict",
      "drain-failed",
    ]),
    message: TrimmedNonEmptyString,
  },
) {}

export interface SshOwnerAdmissionNativeApi {
  readonly getSshOwnerAdmission: () => Promise<SshOwnerAdmissionSnapshot>;
  /** Explicit user action; resolves with the admission after the drain and reboot. */
  readonly drainSshOwnerIdentifiedPanes: () => Promise<SshOwnerAdmissionSnapshot>;
}
