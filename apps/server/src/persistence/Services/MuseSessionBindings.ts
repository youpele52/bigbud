import { Schema, ServiceMap } from "effect";
import type * as Effect from "effect/Effect";

import type { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";

const Bounded = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096));

/**
 * Durable Muse session-creation intent. Kept separate from the runtime
 * directory because ProviderService startup rollback restores/removes that
 * row; losing the only creation record would license a replacement native
 * session. No MCP tokens or ephemeral bridge paths are persisted here.
 */
export const MuseSessionBinding = Schema.Struct({
  threadId: Bounded,
  nativeSessionId: Bounded,
  creationCommandId: Bounded,
  workspace: Bounded,
  storageIdentity: Bounded,
  selectionFingerprint: Bounded,
  createdAt: Bounded,
  phase: Schema.Literals(["reserved", "bound", "blocked"]),
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type MuseSessionBinding = typeof MuseSessionBinding.Type;

export class MuseSessionBindingConflict extends Schema.TaggedErrorClass<MuseSessionBindingConflict>()(
  "MuseSessionBindingConflict",
  { detail: Schema.String },
) {}

export type MuseSessionBindingError =
  | PersistenceSqlError
  | PersistenceDecodeError
  | MuseSessionBindingConflict;

export interface MuseSessionBindingsShape {
  /** Archived native incarnations may never resume or reserve again after workspace reset. */
  readonly isArchived?: (
    threadId: string,
    nativeSessionId: string,
  ) => Effect.Effect<boolean, MuseSessionBindingError>;
  readonly find: (
    threadId: string,
  ) => Effect.Effect<MuseSessionBinding | undefined, MuseSessionBindingError>;
  /** Reserve before native creation; identical replay returns the same row, changed material conflicts. */
  readonly reserve: (
    input: Omit<MuseSessionBinding, "phase" | "revision">,
  ) => Effect.Effect<MuseSessionBinding, MuseSessionBindingError>;
  /** CAS phase advance: reserved -> bound|blocked, never out of blocked/bound. */
  readonly transition: (
    current: MuseSessionBinding,
    phase: "bound" | "blocked",
  ) => Effect.Effect<MuseSessionBinding, MuseSessionBindingError>;
}

export class MuseSessionBindings extends ServiceMap.Service<
  MuseSessionBindings,
  MuseSessionBindingsShape
>()("bigbud/persistence/MuseSessionBindings") {}
