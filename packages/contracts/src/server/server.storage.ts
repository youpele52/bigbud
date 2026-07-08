import { Schema } from "effect";

import { TrimmedNonEmptyString } from "../core/baseSchemas";

export const ServerStoragePaths = Schema.Struct({
  notesDir: TrimmedNonEmptyString,
  kanbanDir: TrimmedNonEmptyString,
});
export type ServerStoragePaths = typeof ServerStoragePaths.Type;
