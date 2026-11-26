import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

// The backend bounds extracted text to 32,000 characters. Leave room for source metadata.
export const MAX_STAGED_DOCUMENT_CHARS = 40_000;

export const PersistedReadDocument = Schema.Struct({
  id: Schema.String,
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_STAGED_DOCUMENT_CHARS)),
});
export type PersistedReadDocument = typeof PersistedReadDocument.Type;

const decodeReadDocument = Schema.decodeUnknownOption(PersistedReadDocument);

export function normalizePersistedReadDocuments(value: unknown): PersistedReadDocument[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((entry) => {
    const document = Option.getOrUndefined(decodeReadDocument(entry));
    if (!document || seen.has(document.id)) return [];
    seen.add(document.id);
    return [document];
  });
}
