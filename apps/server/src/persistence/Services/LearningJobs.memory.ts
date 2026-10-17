import { Schema } from "effect";
import { MemoryDocument } from "../../learning/Services/MemoryStore.ts";

export const LearningMemoryDocuments = Schema.Struct({
  user: MemoryDocument,
  global: MemoryDocument,
  project: MemoryDocument,
});
export type LearningMemoryDocuments = typeof LearningMemoryDocuments.Type;
