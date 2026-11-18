import { Schema } from "effect";

/** Filesystem identity: whitespace is significant; NUL is never a valid path byte. */
export const FilesystemPath = Schema.String.check(
  Schema.isNonEmpty(),
  // oxlint-disable-next-line no-control-regex -- NUL is invalid in every filesystem path.
  Schema.isPattern(/^[^\u0000]+$/),
);
